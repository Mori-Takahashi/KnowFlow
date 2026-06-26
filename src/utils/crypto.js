'use strict';

const crypto = require('crypto');
const debug = require('debug');

const log = debug('knowflow:utils:crypto');

const ALGORITHM = 'aes-256-gcm';
const ENC_PREFIX = 'enc:';
const KEY_SALT = 'knowflow-settings-v1';

let cachedKey = null;

/**
 * Derives the 32-byte AES key from the SETTINGS_ENCRYPTION_KEY environment
 * variable via scrypt. The derived key is cached for the process lifetime.
 *
 * @returns {Buffer} -> 32-byte key buffer.
 * @throws {Error} -> If SETTINGS_ENCRYPTION_KEY is not set.
 */
function getKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY fehlt. Bitte eine zufällige Zeichenkette (>= 16 Zeichen) in der .env setzen.',
    );
  }
  cachedKey = crypto.scryptSync(secret, KEY_SALT, 32);
  return cachedKey;
}

/**
 * Returns true if the SETTINGS_ENCRYPTION_KEY is configured. Used at startup to
 * fail fast with a clear message instead of crashing on the first secret write.
 *
 * @returns {boolean} -> True when an encryption key is available.
 */
function hasEncryptionKey() {
  return Boolean(process.env.SETTINGS_ENCRYPTION_KEY);
}

/**
 * Encrypts a plaintext string with AES-256-GCM. The result is a single string
 * `enc:<ivB64>:<tagB64>:<cipherB64>` so it can be stored in a TEXT column and
 * recognized again by `decrypt`/`isEncrypted`.
 *
 * @param {string|null|undefined} plain -> Plaintext to encrypt.
 * @returns {string} -> Encrypted blob, or '' when input is empty.
 */
function encrypt(plain) {
  if (plain == null || plain === '') return '';
  log('encrypt called');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Returns true if the given value looks like a blob produced by `encrypt`.
 *
 * @param {string|null|undefined} value -> Candidate value.
 * @returns {boolean} -> True if it carries the encryption prefix.
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Decrypts a blob produced by `encrypt`. Returns plaintext unchanged when the
 * value is not encrypted (tolerates legacy plaintext rows during migration).
 *
 * @param {string|null|undefined} blob -> Encrypted blob or plaintext.
 * @returns {string} -> Decrypted plaintext, or '' when input is empty.
 * @throws {Error} -> If the blob is malformed or authentication fails.
 */
function decrypt(blob) {
  if (blob == null || blob === '') return '';
  if (!isEncrypted(blob)) return String(blob);
  log('decrypt called');
  const parts = String(blob).slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Verschlüsselter Wert hat ein ungültiges Format.');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted, hasEncryptionKey };
