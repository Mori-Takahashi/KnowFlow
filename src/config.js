'use strict';

const path = require('path');
const debug = require('debug');

const { hasEncryptionKey } = require('./utils/crypto');
const { ATTACHMENT_MAX_BYTES_DEFAULT } = require('./constants');

const log = debug('knowflow:config');

/**
 * Loads process-level configuration from environment variables.
 *
 * Since the admin dashboard moved runtime configuration (Jira, OpenWebUI,
 * routing, field mappings) into the SQLite-backed settings store, this loader
 * only handles infrastructure-level values that must exist before the database
 * is opened: ports, paths, debug flags, and the secrets used to protect the
 * settings store and the admin session.
 *
 * The Jira/OpenWebUI credentials in the environment are NOT validated here —
 * they are only used once by settingsService.ensureSeeded() to seed the DB on
 * first boot. After that, the DB is the source of truth.
 *
 * @returns {Readonly<Object>} -> Parsed infrastructure config.
 * @throws {Error} -> If SETTINGS_ENCRYPTION_KEY is missing.
 */
function loadConfig() {
  log('loadConfig called');

  if (!hasEncryptionKey()) {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY fehlt. Bitte eine zufällige Zeichenkette (>= 16 Zeichen) in der .env setzen ' +
        '(wird zum Verschlüsseln der in der DB gespeicherten Tokens verwendet).',
    );
  }
  if (!process.env.SESSION_SECRET) {
    console.warn(
      '[config] SESSION_SECRET nicht gesetzt — verwende SETTINGS_ENCRYPTION_KEY als Fallback für Session-Cookies.',
    );
  }

  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
  const databaseUrl = process.env.DATABASE_URL || './data/knowflow.sqlite';
  const webhookDebug = String(process.env.WEBHOOK_DEBUG || 'false').toLowerCase() === 'true';
  const uiDebug = String(process.env.UI_DEBUG || 'false').toLowerCase() === 'true';

  const databaseAbsolutePath = path.isAbsolute(databaseUrl)
    ? databaseUrl
    : path.resolve(process.cwd(), databaseUrl);

  const dummyStorageDir = path.resolve(process.cwd(), 'data', 'openwebui-dummy');

  const attachmentsDirRaw = process.env.ATTACHMENTS_DIR || path.resolve(process.cwd(), 'data', 'attachments');
  const attachmentsDir = path.isAbsolute(attachmentsDirRaw)
    ? attachmentsDirRaw
    : path.resolve(process.cwd(), attachmentsDirRaw);

  const attachmentMaxBytes = Number.parseInt(process.env.ATTACHMENT_MAX_BYTES, 10) > 0
    ? Number.parseInt(process.env.ATTACHMENT_MAX_BYTES, 10)
    : ATTACHMENT_MAX_BYTES_DEFAULT;

  const config = Object.freeze({
    port,
    publicBaseUrl,
    databasePath: databaseAbsolutePath,
    dummyStorageDir,
    attachmentsDir,
    attachmentMaxBytes,
    webhookDebug,
    uiDebug,
  });

  log('config loaded: %o', {
    port: config.port,
    databasePath: config.databasePath,
    webhookDebug: config.webhookDebug,
    uiDebug: config.uiDebug,
  });

  return config;
}

module.exports = { loadConfig };
