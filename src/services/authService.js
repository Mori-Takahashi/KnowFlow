'use strict';

const crypto = require('crypto');
const debug = require('debug');

const settingsService = require('./settingsService');
const { SESSION_ROLES } = require('../constants');

const log = debug('knowflow:authService');

const COOKIE_NAME = 'jb_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const SCRYPT_KEYLEN = 64;

/**
 * Resolves the HMAC secret used to sign session cookies. Prefers SESSION_SECRET
 * and falls back to SETTINGS_ENCRYPTION_KEY so a single configured secret is
 * enough to run the app.
 *
 * @returns {string} -> The signing secret.
 * @throws {Error} -> If neither secret is configured.
 */
function getSessionSecret() {
  const secret = process.env.SESSION_SECRET || process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('SESSION_SECRET (oder SETTINGS_ENCRYPTION_KEY) muss gesetzt sein.');
  }
  return secret;
}

/**
 * Hashes a plaintext password with a random salt via scrypt.
 *
 * @param {string} plain -> Plaintext password.
 * @returns {{salt: string, hash: string}} -> Salt and derived hash (hex).
 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

/**
 * Constant-time verification of a plaintext password against a stored record.
 *
 * @param {string} plain -> Plaintext candidate.
 * @param {{salt: string, hash: string}|null} record -> Stored auth record.
 * @returns {boolean} -> True on match.
 */
function verifyAgainst(plain, record) {
  if (!record || !record.salt || !record.hash) return false;
  const candidate = crypto.scryptSync(plain, record.salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(record.hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/**
 * Ensures an admin password exists. On first boot, if none is stored and
 * ADMIN_PASSWORD is provided in the environment, it is hashed and persisted.
 *
 * @returns {void}
 */
function ensureAdminPassword() {
  log('ensureAdminPassword called');
  const existing = settingsService.getAuthConfig();
  if (existing) return;
  const seed = process.env.ADMIN_PASSWORD;
  if (seed) {
    settingsService.setAuthConfig(hashPassword(seed));
    console.warn('[authService] Admin-Passwort aus ADMIN_PASSWORD übernommen.');
  } else {
    console.warn(
      '[authService] Kein Admin-Passwort gesetzt. Die Ersteinrichtung kann beim ersten Aufruf des Dashboards im Browser über den Setup-Assistenten abgeschlossen werden.',
    );
  }
}

/**
 * Sets the admin password during the first-run setup, but only when none exists
 * yet. This is the unauthenticated counterpart to changePassword used by the
 * public setup endpoint; the "no record yet" guard is what keeps it safe to call
 * without a session.
 *
 * @param {string} plain -> Plaintext password chosen in the setup wizard.
 * @returns {boolean} -> True if set, false if a password already existed (race).
 * @throws {Error} -> If the password is shorter than 6 characters.
 */
function setInitialPassword(plain) {
  log('setInitialPassword called');
  if (!plain || String(plain).length < 6) {
    throw new Error('Das Passwort muss mindestens 6 Zeichen lang sein.');
  }
  if (settingsService.getAuthConfig()) return false;
  settingsService.setAuthConfig(hashPassword(plain));
  return true;
}

/**
 * Verifies a login password against the stored admin record.
 *
 * @param {string} plain -> Submitted password.
 * @returns {boolean} -> True if the password is correct.
 */
function verifyPassword(plain) {
  log('verifyPassword called');
  if (!plain) return false;
  return verifyAgainst(plain, settingsService.getAuthConfig());
}

/**
 * Authenticates a login password and resolves the role it grants. The admin
 * password is checked first so it always wins if both happen to match.
 *
 * @param {string} plain -> Submitted password.
 * @returns {string|null} -> SESSION_ROLES value, or null when the password is wrong.
 */
function authenticate(plain) {
  log('authenticate called');
  if (!plain) return null;
  if (verifyAgainst(plain, settingsService.getAuthConfig())) return SESSION_ROLES.ADMIN;
  if (verifyAgainst(plain, settingsService.getUserAuthConfig())) return SESSION_ROLES.USER;
  return null;
}

/**
 * Returns whether a (non-admin) user password has been configured.
 *
 * @returns {boolean} -> True when a user login exists.
 */
function hasUserPassword() {
  return Boolean(settingsService.getUserAuthConfig());
}

/**
 * Sets (or replaces) the user password. Passing an empty value removes the
 * user login entirely.
 *
 * @param {string} plain -> New user password, or '' / null to remove it.
 * @returns {boolean} -> True when a password was set, false when it was removed.
 * @throws {Error} -> If a non-empty password is shorter than 6 characters.
 */
function setUserPassword(plain) {
  log('setUserPassword called');
  if (!plain) {
    settingsService.setUserAuthConfig(null);
    return false;
  }
  if (String(plain).length < 6) {
    throw new Error('Das Benutzer-Passwort muss mindestens 6 Zeichen lang sein.');
  }
  settingsService.setUserAuthConfig(hashPassword(plain));
  return true;
}

/**
 * Changes the admin password after verifying the current one.
 *
 * @param {string} currentPlain -> Current password.
 * @param {string} nextPlain -> New password.
 * @returns {boolean} -> True if changed, false if the current password is wrong.
 * @throws {Error} -> If the new password is too short.
 */
function changePassword(currentPlain, nextPlain) {
  log('changePassword called');
  if (!verifyPassword(currentPlain)) return false;
  if (!nextPlain || String(nextPlain).length < 6) {
    throw new Error('Das neue Passwort muss mindestens 6 Zeichen lang sein.');
  }
  settingsService.setAuthConfig(hashPassword(nextPlain));
  return true;
}

/**
 * Computes the base64url HMAC signature for a payload segment.
 *
 * @param {string} segment -> base64url-encoded payload.
 * @returns {string} -> base64url signature.
 */
function sign(segment) {
  return crypto.createHmac('sha256', getSessionSecret()).update(segment).digest('base64url');
}

/**
 * Issues a signed session token valid for SESSION_TTL_MS.
 *
 * @param {string} [role=SESSION_ROLES.ADMIN] -> Role the session grants.
 * @returns {string} -> The session token (`payload.signature`).
 */
function issueToken(role = SESSION_ROLES.ADMIN) {
  const payload = { role, exp: Date.now() + SESSION_TTL_MS };
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${segment}.${sign(segment)}`;
}

/**
 * Verifies a token's signature and returns its decoded, unexpired payload.
 *
 * @param {string|undefined|null} token -> Token from the cookie.
 * @returns {Object|null} -> The payload, or null when invalid/expired.
 */
function decodeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const segment = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(segment);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
    return payload;
  } catch (_err) {
    return null;
  }
}

/**
 * Resolves the role a session token grants. Legacy tokens carrying `admin:true`
 * are treated as admin so existing sessions keep working after the upgrade.
 *
 * @param {string|undefined|null} token -> Token from the cookie.
 * @returns {string|null} -> SESSION_ROLES value, or null when invalid.
 */
function getSessionRole(token) {
  const payload = decodeToken(token);
  if (!payload) return null;
  if (payload.role === SESSION_ROLES.ADMIN || payload.admin === true) return SESSION_ROLES.ADMIN;
  if (payload.role === SESSION_ROLES.USER) return SESSION_ROLES.USER;
  return null;
}

/**
 * Verifies a session token's signature and expiry (any role).
 *
 * @param {string|undefined|null} token -> Token from the cookie.
 * @returns {boolean} -> True if valid and unexpired.
 */
function verifyToken(token) {
  return getSessionRole(token) !== null;
}

/**
 * Returns the cookie options used for the session cookie.
 *
 * @returns {Object} -> express res.cookie options.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

module.exports = {
  COOKIE_NAME,
  ensureAdminPassword,
  setInitialPassword,
  verifyPassword,
  authenticate,
  hasUserPassword,
  setUserPassword,
  changePassword,
  issueToken,
  verifyToken,
  getSessionRole,
  cookieOptions,
};
