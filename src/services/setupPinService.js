'use strict';

const crypto = require('crypto');
const debug = require('debug');

const log = debug('knowflow:setupPinService');

const SETUP_COOKIE_NAME = 'kf_setup';
const SETUP_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PIN_LENGTH = 6;

// In-memory PIN for the current process. Regenerated on every boot while the
// first-run setup is still pending, and never persisted — restarting the server
// rotates it. null means no setup PIN is active (setup already completed).
let currentPin = null;

/**
 * Resolves the HMAC secret used to sign short-lived setup-session tokens. Mirrors
 * authService.getSessionSecret so a single configured secret protects both. By
 * the time this runs the boot step has guaranteed at least one of these exists.
 *
 * @returns {string} -> The signing secret.
 * @throws {Error} -> If neither secret is configured.
 */
function getSetupSecret() {
  const secret = process.env.SESSION_SECRET || process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('SESSION_SECRET (oder SETTINGS_ENCRYPTION_KEY) muss gesetzt sein.');
  }
  return secret;
}

/**
 * Generates a fresh zero-padded 6-digit PIN and stores it in memory as the
 * active setup PIN. Uses a rejection-free uniform draw via crypto.randomInt.
 *
 * @returns {string} -> The generated 6-digit PIN.
 */
function generatePin() {
  log('generatePin called');
  const max = 10 ** PIN_LENGTH; // exclusive upper bound, e.g. 1_000_000
  currentPin = String(crypto.randomInt(0, max)).padStart(PIN_LENGTH, '0');
  return currentPin;
}

/**
 * Returns the active setup PIN, or null when none is set.
 *
 * @returns {string|null} -> The current PIN.
 */
function getPin() {
  return currentPin;
}

/**
 * Clears the active setup PIN (called once setup completes) so verifyPin always
 * fails afterwards even within the same process.
 *
 * @returns {void}
 */
function clearPin() {
  currentPin = null;
}

/**
 * Constant-time check of a submitted PIN against the active one. Always returns
 * false when no PIN is active.
 *
 * @param {string} input -> The submitted PIN.
 * @returns {boolean} -> True on an exact match.
 */
function verifyPin(input) {
  log('verifyPin called');
  if (!currentPin || typeof input !== 'string') return false;
  const candidate = Buffer.from(input);
  const expected = Buffer.from(currentPin);
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * Computes the base64url HMAC signature for a payload segment.
 *
 * @param {string} segment -> base64url-encoded payload.
 * @returns {string} -> base64url signature.
 */
function sign(segment) {
  return crypto.createHmac('sha256', getSetupSecret()).update(segment).digest('base64url');
}

/**
 * Issues a short-lived signed setup-session token. Possession of this token
 * (proven by the kf_setup cookie) is what authorizes POST /api/setup/complete.
 *
 * @returns {string} -> The token (`payload.signature`).
 */
function issueSetupSession() {
  const payload = { scope: 'setup', exp: Date.now() + SETUP_SESSION_TTL_MS };
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${segment}.${sign(segment)}`;
}

/**
 * Verifies a setup-session token's signature, scope, and expiry.
 *
 * @param {string|undefined|null} token -> Token from the kf_setup cookie.
 * @returns {boolean} -> True if valid and unexpired.
 */
function verifySetupSession(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const segment = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(segment);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (payload.scope !== 'setup') return false;
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return false;
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Returns the cookie options used for the short-lived setup-session cookie.
 *
 * @returns {Object} -> express res.cookie options.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SETUP_SESSION_TTL_MS,
    path: '/',
  };
}

/**
 * Prints a prominent, multi-line console block announcing the setup PIN and the
 * URL where the browser wizard can be reached. Called once at boot when the
 * first-run setup is still pending.
 *
 * @param {string} publicBaseUrl -> The base URL the wizard is served from.
 * @returns {void}
 */
function printPin(publicBaseUrl) {
  if (!currentPin) return;
  const url = publicBaseUrl || 'http://localhost:3000';
  const lines = [
    '',
    '========================================================',
    '  KNOWFLOW ERSTEINRICHTUNG — SETUP-PIN',
    '========================================================',
    `  Setup im Browser öffnen:  ${url}`,
    `  PIN für die Anmeldung:    ${currentPin}`,
    '',
    '  Diesen PIN im Setup-Assistenten eingeben, um die',
    '  Ersteinrichtung zu starten. Der PIN gilt nur für',
    '  diesen Serverstart und wird bei jedem Neustart neu',
    '  erzeugt, solange das Setup nicht abgeschlossen ist.',
    '========================================================',
    '',
  ];
  console.warn(lines.join('\n'));
}

module.exports = {
  SETUP_COOKIE_NAME,
  generatePin,
  getPin,
  clearPin,
  verifyPin,
  issueSetupSession,
  verifySetupSession,
  cookieOptions,
  printPin,
};
