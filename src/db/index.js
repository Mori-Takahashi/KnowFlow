'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const debug = require('debug');

const { applySchema } = require('./schema');

const log = debug('knowflow:db');

let dbInstance = null;

/**
 * Opens (and lazily creates) the SQLite database, applies the schema, and
 * returns the shared connection. Subsequent calls return the cached instance.
 *
 * @param {string} databasePath -> Absolute path to the SQLite file.
 * @returns {import('better-sqlite3').Database} -> Connected database.
 * @throws {Error} -> If the parent directory cannot be created or DB cannot be opened.
 */
function openDatabase(databasePath) {
  log('openDatabase called with: %o', { databasePath });
  if (dbInstance) return dbInstance;

  try {
    const dir = path.dirname(databasePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    applySchema(db);
    dbInstance = db;
    log('database opened and schema applied');
    return db;
  } catch (err) {
    console.error('[db] openDatabase failed:', err.message);
    throw err;
  }
}

/**
 * Returns the currently open database connection. Must call openDatabase first.
 *
 * @returns {import('better-sqlite3').Database} -> The open database.
 * @throws {Error} -> If openDatabase has not been called yet.
 */
function getDatabase() {
  if (!dbInstance) {
    throw new Error('Datenbank wurde noch nicht initialisiert. openDatabase() zuerst aufrufen.');
  }
  return dbInstance;
}

module.exports = { openDatabase, getDatabase };
