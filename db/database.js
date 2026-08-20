'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../loyalty.db');

let db;

/**
 * Open the SQLite database and create tables if they do not yet exist.
 */
function initDatabase() {
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      serial_number TEXT UNIQUE NOT NULL,
      auth_token    TEXT NOT NULL,
      stamps        INTEGER DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS devices (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      device_library_id     TEXT NOT NULL,
      push_token            TEXT NOT NULL,
      serial_number         TEXT NOT NULL,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(device_library_id, serial_number)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

/**
 * Return the open database instance (throws if initDatabase() was not called).
 */
function getDb() {
  if (!db) {
    throw new Error('Database has not been initialised. Call initDatabase() first.');
  }
  return db;
}

// ── Customer queries ──────────────────────────────────────────────────────────

function createCustomer({ id, name, email, serialNumber, authToken }) {
  const stmt = getDb().prepare(`
    INSERT INTO customers (id, name, email, serial_number, auth_token)
    VALUES (@id, @name, @email, @serialNumber, @authToken)
  `);
  stmt.run({ id, name, email, serialNumber, authToken });
}

function getCustomerByEmail(email) {
  return getDb()
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(email);
}

function getCustomerBySerial(serialNumber) {
  return getDb()
    .prepare('SELECT * FROM customers WHERE serial_number = ?')
    .get(serialNumber);
}

function getCustomerById(id) {
  return getDb()
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(id);
}

function getAllCustomers() {
  return getDb()
    .prepare('SELECT * FROM customers ORDER BY created_at DESC')
    .all();
}

/**
 * Increment stamps by 1 and update the updated_at timestamp.
 * Returns the updated customer row.
 */
function addStamp(customerId) {
  const db = getDb();
  db.prepare(`
    UPDATE customers
    SET stamps     = stamps + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(customerId);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
}

// ── Settings queries ──────────────────────────────────────────────────────────

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb()
    .prepare(`
      INSERT INTO app_settings (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    .run({ key, value });
}

/**
 * Bump updated_at for the given serial numbers so the next pass fetch isn't
 * short-circuited by the If-Modified-Since check in the wallet web service.
 */
function touchCustomers(serialNumbers) {
  if (!serialNumbers || serialNumbers.length === 0) return;
  const placeholders = serialNumbers.map(() => '?').join(',');
  getDb()
    .prepare(`UPDATE customers SET updated_at = CURRENT_TIMESTAMP WHERE serial_number IN (${placeholders})`)
    .run(...serialNumbers);
}

// ── Device queries ────────────────────────────────────────────────────────────

function registerDevice({ deviceLibraryId, pushToken, serialNumber }) {
  getDb()
    .prepare(`
      INSERT INTO devices (device_library_id, push_token, serial_number)
      VALUES (@deviceLibraryId, @pushToken, @serialNumber)
      ON CONFLICT(device_library_id, serial_number) DO UPDATE SET push_token = excluded.push_token
    `)
    .run({ deviceLibraryId, pushToken, serialNumber });
}

function unregisterDevice({ deviceLibraryId, serialNumber }) {
  getDb()
    .prepare(`
      DELETE FROM devices
      WHERE device_library_id = ? AND serial_number = ?
    `)
    .run(deviceLibraryId, serialNumber);
}

/**
 * Return all device rows that have registered for any of the given serial numbers.
 */
function getDevicesForSerials(serialNumbers) {
  if (!serialNumbers || serialNumbers.length === 0) return [];
  const placeholders = serialNumbers.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM devices WHERE serial_number IN (${placeholders})`)
    .all(...serialNumbers);
}

/**
 * Return all device rows for a single serial number.
 */
function getDevicesForSerial(serialNumber) {
  return getDb()
    .prepare('SELECT * FROM devices WHERE serial_number = ?')
    .all(serialNumber);
}

/**
 * Return every unique serial number that has at least one registered device.
 */
function getRegisteredSerials() {
  return getDb()
    .prepare('SELECT DISTINCT serial_number FROM devices')
    .all()
    .map((r) => r.serial_number);
}

/**
 * Return serials that were updated after the given ISO timestamp (for Apple's
 * "passes updated since" endpoint).
 */
function getSerialsUpdatedSince(passTypeIdentifier, updatedSince) {
  // We filter by updated_at so Apple only fetches genuinely changed passes.
  // passTypeIdentifier is stored in the env, not the DB, so we return all
  // updated serials and let the caller filter by pass type if needed.
  if (updatedSince) {
    return getDb()
      .prepare(`
        SELECT c.serial_number
        FROM   customers c
        JOIN   devices   d ON d.serial_number = c.serial_number
        WHERE  c.updated_at > ?
        GROUP  BY c.serial_number
      `)
      .all(updatedSince)
      .map((r) => r.serial_number);
  }
  return getRegisteredSerials();
}

module.exports = {
  initDatabase,
  getDb,
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
  // devices
  registerDevice,
  unregisterDevice,
  getDevicesForSerials,
  getDevicesForSerial,
  getRegisteredSerials,
  getSerialsUpdatedSince,
};
