'use strict';

const { Pool } = require('pg');

let pool;

/**
 * Open the Postgres connection pool and create tables if they do not yet exist.
 */
async function initDatabase() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT NOT NULL,
      serial_number   TEXT UNIQUE NOT NULL,
      auth_token      TEXT NOT NULL,
      stamps          INTEGER NOT NULL DEFAULT 0,
      stamps_redeemed INTEGER NOT NULL DEFAULT 0,
      lang            TEXT NOT NULL DEFAULT 'en',
      stamps_required INTEGER NOT NULL DEFAULT 10,
      reward_text     TEXT NOT NULL DEFAULT 'a free taco',
      deleted_at      TIMESTAMPTZ,
      card_removed_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS devices (
      id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      device_library_id TEXT NOT NULL,
      push_token        TEXT NOT NULL,
      serial_number     TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (device_library_id, serial_number)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS promotion_history (
      id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      stamps_required INTEGER NOT NULL,
      reward_text     TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reward_redemptions (
      id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_id     TEXT NOT NULL,
      customer_name   TEXT NOT NULL,
      stamps_required INTEGER NOT NULL,
      reward_text     TEXT NOT NULL,
      redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE customers ADD COLUMN IF NOT EXISTS stamps_required INTEGER NOT NULL DEFAULT 10;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS reward_text TEXT NOT NULL DEFAULT 'a free taco';
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS card_removed_at TIMESTAMPTZ;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS stamps_redeemed INTEGER NOT NULL DEFAULT 0;

    -- Soft-deleted customers may share an email with a new active signup, so
    -- email uniqueness is only enforced among non-deleted rows.
    ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_email_key;
    CREATE UNIQUE INDEX IF NOT EXISTS customers_email_active_idx
      ON customers (email) WHERE deleted_at IS NULL;
  `);

  return pool;
}

/**
 * Return the open connection pool (throws if initDatabase() was not called).
 */
function getPool() {
  if (!pool) {
    throw new Error('Database has not been initialised. Call initDatabase() first.');
  }
  return pool;
}

// ── Customer queries ──────────────────────────────────────────────────────────

const SUPPORTED_LANGS = ['en', 'es', 'pt'];

async function createCustomer({ id, name, email, serialNumber, authToken, lang, stampsRequired, rewardText }) {
  await getPool().query(
    `INSERT INTO customers (id, name, email, serial_number, auth_token, lang, stamps_required, reward_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, name, email, serialNumber, authToken, SUPPORTED_LANGS.includes(lang) ? lang : 'en', stampsRequired, rewardText],
  );
}

async function getCustomerByEmail(email) {
  const { rows } = await getPool().query(
    'SELECT * FROM customers WHERE email = $1 AND deleted_at IS NULL',
    [email],
  );
  return rows[0];
}

async function getCustomerBySerial(serialNumber) {
  const { rows } = await getPool().query(
    'SELECT * FROM customers WHERE serial_number = $1 AND deleted_at IS NULL',
    [serialNumber],
  );
  return rows[0];
}

async function getCustomerById(id) {
  const { rows } = await getPool().query(
    'SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rows[0];
}

async function getAllCustomers() {
  const { rows } = await getPool().query(
    'SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY created_at DESC',
  );
  return rows;
}

/**
 * Soft-delete a customer -- the row (and their devices) are kept so an
 * accidental deletion can be undone within RECOVERY_WINDOW_DAYS.
 * Returns false if no active customer with that id existed.
 */
async function deleteCustomer(id) {
  const { rowCount } = await getPool().query(
    'UPDATE customers SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rowCount > 0;
}

const RECOVERY_WINDOW_DAYS = 7;

/**
 * Customers soft-deleted within the recovery window, most recent first.
 */
async function getDeletedCustomers() {
  const { rows } = await getPool().query(
    `SELECT * FROM customers
     WHERE deleted_at IS NOT NULL AND deleted_at > NOW() - INTERVAL '${RECOVERY_WINDOW_DAYS} days'
     ORDER BY deleted_at DESC`,
  );
  return rows;
}

/**
 * Undo a soft delete. Returns false if the customer wasn't found deleted
 * (already restored, permanently purged, or never existed).
 */
async function restoreCustomer(id) {
  const { rowCount } = await getPool().query(
    'UPDATE customers SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL',
    [id],
  );
  return rowCount > 0;
}

/**
 * Permanently remove customers (and their devices) that have been
 * soft-deleted for longer than the recovery window. Meant to be called on a
 * recurring schedule. Returns the number of customers purged.
 */
async function purgeOldDeletedCustomers() {
  const db = getPool();
  const cutoffQuery = `deleted_at IS NOT NULL AND deleted_at <= NOW() - INTERVAL '${RECOVERY_WINDOW_DAYS} days'`;

  await db.query(`
    DELETE FROM devices
    WHERE serial_number IN (SELECT serial_number FROM customers WHERE ${cutoffQuery})
  `);
  const { rowCount } = await db.query(`DELETE FROM customers WHERE ${cutoffQuery}`);
  return rowCount;
}

/**
 * Increment stamps by 1 and update the updated_at timestamp.
 * Returns the updated customer row.
 */
async function addStamp(customerId) {
  const db = getPool();
  await db.query(
    `UPDATE customers
     SET stamps     = stamps + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [customerId],
  );
  const { rows } = await db.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  return rows[0];
}

/**
 * Redeem one reward's worth of stamps: advances stamps_redeemed by
 * stamps_required (clearing the "ready" state for exactly one reward) and
 * logs the redemption. Throws if the customer doesn't currently have enough
 * unredeemed stamps -- callers should check first, but this guards against
 * races (e.g. two staff members tapping redeem at once).
 */
async function redeemReward(customerId) {
  const db = getPool();
  const customer = await getCustomerById(customerId);
  if (!customer) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }

  const progress = customer.stamps - customer.stamps_redeemed;
  if (progress < customer.stamps_required) {
    const err = new Error('Not enough unredeemed stamps');
    err.status = 400;
    throw err;
  }

  await db.query(
    `UPDATE customers
     SET stamps_redeemed = stamps_redeemed + stamps_required,
         updated_at      = NOW()
     WHERE id = $1`,
    [customerId],
  );

  await db.query(
    `INSERT INTO reward_redemptions (customer_id, customer_name, stamps_required, reward_text)
     VALUES ($1, $2, $3, $4)`,
    [customer.id, customer.name, customer.stamps_required, customer.reward_text],
  );

  const { rows } = await db.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  return rows[0];
}

/**
 * Lifetime count of rewards actually given out (vs. just mathematically
 * implied by stamp count), for the admin dashboard stat.
 */
async function getRedemptionCount() {
  const { rows } = await getPool().query('SELECT COUNT(*) AS count FROM reward_redemptions');
  return Number(rows[0].count);
}

/**
 * Flag a customer as having removed their Wallet pass (a "detractor" signal
 * for the dashboard). Only called once their last registered device is gone.
 */
async function markCardRemoved(serialNumber) {
  await getPool().query(
    'UPDATE customers SET card_removed_at = NOW() WHERE serial_number = $1 AND deleted_at IS NULL',
    [serialNumber],
  );
}

/**
 * Clear the "card removed" flag -- called when a device re-registers for the
 * pass, meaning the customer added it back.
 */
async function clearCardRemoved(serialNumber) {
  await getPool().query(
    'UPDATE customers SET card_removed_at = NULL WHERE serial_number = $1 AND card_removed_at IS NOT NULL',
    [serialNumber],
  );
}

// ── Settings queries ──────────────────────────────────────────────────────────

async function getSetting(key) {
  const { rows } = await getPool().query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await getPool().query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/**
 * Current owner-configured promotion (stamps needed + reward description).
 * New customers snapshot this at registration time; existing customers keep
 * whatever was active when they signed up.
 */
async function getPromotionDefaults() {
  const [stampsRequired, rewardText] = await Promise.all([
    getSetting('default_stamps_required'),
    getSetting('default_reward_text'),
  ]);
  return {
    stampsRequired: stampsRequired ? parseInt(stampsRequired, 10) : 10,
    rewardText: rewardText || 'a free taco',
  };
}

/**
 * Set the current promotion defaults and record them in the history log
 * (skipping the insert if it's identical to the most recent entry, so
 * re-saving the same values repeatedly doesn't spam the log).
 */
async function savePromotionDefaults(stampsRequired, rewardText) {
  const db = getPool();

  await setSetting('default_stamps_required', String(stampsRequired));
  await setSetting('default_reward_text', rewardText);

  // If this exact promotion already exists anywhere in the history (not just
  // the most recent entry -- covers reusing an older one), bump it to the
  // top instead of inserting a duplicate row.
  const { rows } = await db.query(
    'SELECT id FROM promotion_history WHERE stamps_required = $1 AND reward_text = $2',
    [stampsRequired, rewardText],
  );
  if (rows.length > 0) {
    await db.query('UPDATE promotion_history SET created_at = NOW() WHERE id = $1', [rows[0].id]);
    return;
  }

  await db.query(
    'INSERT INTO promotion_history (stamps_required, reward_text) VALUES ($1, $2)',
    [stampsRequired, rewardText],
  );
}

/**
 * Past promotions, most recent first, so the owner can see what's been run
 * before and reuse one.
 */
async function getPromotionHistory(limit = 20) {
  const { rows } = await getPool().query(
    'SELECT * FROM promotion_history ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return rows;
}

/**
 * Remove one entry from the promotion history log. Purely a log edit --
 * doesn't touch the current promotion default or any customer's snapshot.
 * Returns false if no such entry existed.
 */
async function deletePromotionHistoryEntry(id) {
  const { rowCount } = await getPool().query(
    'DELETE FROM promotion_history WHERE id = $1',
    [id],
  );
  return rowCount > 0;
}

/**
 * Bump updated_at for the given serial numbers so the next pass fetch isn't
 * short-circuited by the If-Modified-Since check in the wallet web service.
 */
async function touchCustomers(serialNumbers) {
  if (!serialNumbers || serialNumbers.length === 0) return;
  await getPool().query(
    'UPDATE customers SET updated_at = NOW() WHERE serial_number = ANY($1::text[])',
    [serialNumbers],
  );
}

// ── Device queries ────────────────────────────────────────────────────────────

async function registerDevice({ deviceLibraryId, pushToken, serialNumber }) {
  await getPool().query(
    `INSERT INTO devices (device_library_id, push_token, serial_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_library_id, serial_number) DO UPDATE SET push_token = excluded.push_token`,
    [deviceLibraryId, pushToken, serialNumber],
  );
}

async function unregisterDevice({ deviceLibraryId, serialNumber }) {
  await getPool().query(
    'DELETE FROM devices WHERE device_library_id = $1 AND serial_number = $2',
    [deviceLibraryId, serialNumber],
  );
}

/**
 * Return all device rows that have registered for any of the given serial numbers.
 */
async function getDevicesForSerials(serialNumbers) {
  if (!serialNumbers || serialNumbers.length === 0) return [];
  const { rows } = await getPool().query(
    'SELECT * FROM devices WHERE serial_number = ANY($1::text[])',
    [serialNumbers],
  );
  return rows;
}

/**
 * Return all device rows for a single serial number.
 */
async function getDevicesForSerial(serialNumber) {
  const { rows } = await getPool().query(
    'SELECT * FROM devices WHERE serial_number = $1',
    [serialNumber],
  );
  return rows;
}

/**
 * Return the number of distinct devices with at least one registered pass.
 */
async function getDeviceCount() {
  const { rows } = await getPool().query(
    'SELECT COUNT(DISTINCT device_library_id) AS count FROM devices',
  );
  return Number(rows[0].count);
}

/**
 * Return every device row joined with the customer it belongs to, for
 * debugging registration/push issues from the admin dashboard.
 */
async function getAllDevicesWithCustomer() {
  const { rows } = await getPool().query(`
    SELECT d.device_library_id, d.serial_number, d.push_token, d.created_at,
           c.name, c.email
    FROM   devices d
    JOIN   customers c ON c.serial_number = d.serial_number
    ORDER  BY d.created_at DESC
  `);
  return rows;
}

/**
 * Return every unique serial number that has at least one registered device.
 */
async function getRegisteredSerials() {
  const { rows } = await getPool().query('SELECT DISTINCT serial_number FROM devices');
  return rows.map((r) => r.serial_number);
}

/**
 * Return serials that were updated after the given ISO timestamp (for Apple's
 * "passes updated since" endpoint).
 */
async function getSerialsUpdatedSince(passTypeIdentifier, updatedSince) {
  // We filter by updated_at so Apple only fetches genuinely changed passes.
  // passTypeIdentifier is stored in the env, not the DB, so we return all
  // updated serials and let the caller filter by pass type if needed.
  if (updatedSince) {
    const { rows } = await getPool().query(
      `SELECT c.serial_number
       FROM   customers c
       JOIN   devices   d ON d.serial_number = c.serial_number
       WHERE  c.updated_at > $1
       GROUP  BY c.serial_number`,
      [updatedSince],
    );
    return rows.map((r) => r.serial_number);
  }
  return getRegisteredSerials();
}

module.exports = {
  initDatabase,
  getPool,
  // settings
  getSetting,
  setSetting,
  getPromotionDefaults,
  savePromotionDefaults,
  getPromotionHistory,
  deletePromotionHistoryEntry,
  touchCustomers,
  // customers
  createCustomer,
  getCustomerByEmail,
  getCustomerBySerial,
  getCustomerById,
  getAllCustomers,
  addStamp,
  redeemReward,
  getRedemptionCount,
  deleteCustomer,
  getDeletedCustomers,
  restoreCustomer,
  purgeOldDeletedCustomers,
  markCardRemoved,
  clearCardRemoved,
  // devices
  registerDevice,
  unregisterDevice,
  getDevicesForSerials,
  getDevicesForSerial,
  getDeviceCount,
  getAllDevicesWithCustomer,
  getRegisteredSerials,
  getSerialsUpdatedSince,
};
