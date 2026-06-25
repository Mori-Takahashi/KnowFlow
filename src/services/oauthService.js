'use strict';

const crypto = require('crypto');
const debug = require('debug');

const log = debug('knowflow:oauthService');

// Lifetimes for the various signed artifacts.
const CODE_TTL_MS = 5 * 60 * 1000; // authorization code: short-lived
const ACCESS_TTL_MS = 60 * 60 * 1000; // access token: 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // refresh token: 30 days
const CLIENT_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // dynamic client id: effectively permanent

/**
 * Resolves the HMAC secret used to sign OAuth artifacts. Shares the session
 * secret so a single configured value is enough to run the app.
 *
 * @returns {string} -> The signing secret.
 * @throws {Error} -> If neither secret is configured.
 */
function getSecret() {
  const secret = process.env.SESSION_SECRET || process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('SESSION_SECRET (oder SETTINGS_ENCRYPTION_KEY) muss gesetzt sein.');
  }
  return secret;
}

/**
 * Computes the base64url HMAC signature for a payload segment.
 *
 * @param {string} segment -> base64url-encoded payload.
 * @returns {string} -> base64url signature.
 */
function sign(segment) {
  return crypto.createHmac('sha256', getSecret()).update(segment).digest('base64url');
}

/**
 * Encodes and signs a JSON payload into a `segment.signature` token.
 *
 * @param {Object} obj -> JSON-serializable payload (should carry `exp`).
 * @returns {string} -> The signed token.
 */
function encode(obj) {
  const segment = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${segment}.${sign(segment)}`;
}

/**
 * Verifies a signed token's signature and expiry, returning its payload.
 *
 * @param {string|undefined|null} token -> The signed token.
 * @returns {Object|null} -> The payload, or null when invalid/expired.
 */
function decode(token) {
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
    if (typeof payload.exp === 'number' && payload.exp <= Date.now()) return null;
    return payload;
  } catch (_err) {
    return null;
  }
}

/**
 * Issues a dynamic client id that statelessly encodes its registered redirect
 * URIs (RFC 7591 dynamic client registration without server-side storage).
 *
 * @param {string[]} redirectUris -> Registered redirect URIs.
 * @returns {string} -> The client id (prefixed `kfc_`).
 */
function issueClientId(redirectUris) {
  log('issueClientId called');
  return `kfc_${encode({ t: 'client', ru: redirectUris, exp: Date.now() + CLIENT_TTL_MS })}`;
}

/**
 * Parses and verifies a dynamic client id.
 *
 * @param {string} clientId -> The client id.
 * @returns {{ru: string[]}|null} -> The client record, or null when invalid.
 */
function parseClientId(clientId) {
  if (!clientId || !clientId.startsWith('kfc_')) return null;
  const payload = decode(clientId.slice(4));
  return payload && payload.t === 'client' ? payload : null;
}

/**
 * Issues an authorization code bound to a connection, redirect URI, PKCE
 * challenge and the role of the user who authenticated.
 *
 * Known limitation: codes are stateless (HMAC-signed, no server-side store), so
 * they are not strictly single-use and could be replayed within the short
 * CODE_TTL_MS window. The mandatory PKCE S256 verifier (held only by the
 * legitimate client) is what prevents an intercepted code from being redeemed.
 * See SECURITY.md.
 *
 * @param {Object} args -> { conn, redirectUri, codeChallenge, role }.
 * @returns {string} -> The signed authorization code.
 */
function issueCode({ conn, redirectUri, codeChallenge, role }) {
  return encode({ t: 'code', conn, ru: redirectUri, cc: codeChallenge, role, exp: Date.now() + CODE_TTL_MS });
}

/**
 * Verifies an authorization code.
 *
 * @param {string} code -> The code.
 * @returns {Object|null} -> The code payload, or null.
 */
function verifyCode(code) {
  const payload = decode(code);
  return payload && payload.t === 'code' ? payload : null;
}

/**
 * Issues a bearer access token scoped to a connection.
 *
 * @param {Object} args -> { conn, role }.
 * @returns {string} -> The access token.
 */
function issueAccessToken({ conn, role }) {
  return encode({ t: 'at', conn, role, exp: Date.now() + ACCESS_TTL_MS });
}

/**
 * Verifies a bearer access token, optionally checking it is scoped to a
 * specific connection.
 *
 * @param {string} token -> The access token.
 * @param {string} [conn] -> Expected connection id.
 * @returns {Object|null} -> The token payload, or null when invalid.
 */
function verifyAccessToken(token, conn) {
  const payload = decode(token);
  if (!payload || payload.t !== 'at') return null;
  if (conn && payload.conn !== conn) return null;
  return payload;
}

/**
 * Issues a refresh token scoped to a connection.
 *
 * @param {Object} args -> { conn, role }.
 * @returns {string} -> The refresh token.
 */
function issueRefreshToken({ conn, role }) {
  return encode({ t: 'rt', conn, role, exp: Date.now() + REFRESH_TTL_MS });
}

/**
 * Verifies a refresh token.
 *
 * @param {string} token -> The refresh token.
 * @returns {Object|null} -> The token payload, or null.
 */
function verifyRefreshToken(token) {
  const payload = decode(token);
  return payload && payload.t === 'rt' ? payload : null;
}

/**
 * Verifies a PKCE code_verifier against a stored S256 code_challenge.
 *
 * @param {string} verifier -> The code_verifier from the token request.
 * @param {string} challenge -> The code_challenge from the auth request.
 * @returns {boolean} -> True when they match.
 */
function verifyPkce(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (hash.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(challenge));
}

module.exports = {
  ACCESS_TTL_MS,
  issueClientId,
  parseClientId,
  issueCode,
  verifyCode,
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  verifyPkce,
};
