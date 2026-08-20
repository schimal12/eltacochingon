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
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      serial_number TEXT UNIQUE NOT NULL,
      auth_token    TEXT NOT NULL,
      stamps        INTEGER NOT NULL DEFAULT 0,
      lang          TEXT NOT NULL DEFAULT 'en',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

async function createCustomer({ id, name, email, serialNumber, authToken, lang }) {
  await getPool().query(
    `INSERT INTO customers (id, name, email, serial_number, auth_token, lang)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, name, email, serialNumber, authToken, lang === 'es' ? 'es' : 'en'],
  );
}

async function getCustomerByEmail(email) {
  const { rows } = await getPool().query('SELECT * FROM customers WHERE email = $1', [email]);
  return rows[0];
}

async function getCustomerBySerial(serialNumber) {
  const { rows } = await getPool().query(
    'SELECT * FROM customers WHERE serial_number = $1',
    [serialNumber],
  );
  return rows[0];
}

async function getCustomerById(id) {
  const { rows } = await getPool().query('SELECT * FROM customers WHERE id = $1', [id]);
  return rows[0];
}

async function getAllCustomers() {
  const { rows } = await getPool().query('SELECT * FROM customers ORDER BY created_at DESC');
  return rows;
}

/**
 * Delete a customer and any devices registered for their pass.
 * Returns false if the customer did not exist.
 */
async function deleteCustomer(id) {
  const db = getPool();
  const customer = await getCustomerById(id);
  if (!customer) return false;

  await db.query('DELETE FROM devices WHERE serial_number = $1', [customer.serial_number]);
  await db.query('DELETE FROM customers WHERE id = $1', [id]);
  return true;
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
  touchCustomers,
  // customers
  createCustomer,
  getCustomerByEmail,
  getCustomerBySerial,
  getCustomerById,
  getAllCustomers,
  addStamp,
  deleteCustomer,
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
