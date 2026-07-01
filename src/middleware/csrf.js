'use strict';

const crypto = require('crypto');

const CSRF_COOKIE = 'kf-csrf';
const CSRF_HEADER = 'x-csrf-token';

// Endpoints that don't rely on an ambient session cookie for authentication and
// are therefore not subject to CSRF: HMAC- or Bearer-token-authenticated APIs,
// plus the browser-rendered OAuth login form which re-authenticates via the
// password submitted in the request body (a plain HTML form cannot send the
// x-csrf-token header, and forging it would require knowing the password).
const CSRF_EXEMPT_PREFIXES = [
  '/webhook/',
  '/mcp/',
  '/oauth/token',
  '/oauth/register',
  '/oauth/authorize',
  '/api/setup',
  '/.well-known/',
];

/**
 * Double-submit-cookie CSRF protection for cookie-authenticated routes.
 *
 * On every response the middleware sets a random `kf-csrf` cookie (readable
 * by JS, SameSite=Lax). State-changing requests (POST/PUT/PATCH/DELETE) must
 * echo that value back via the `x-csrf-token` request header.
 * Endpoints that use HMAC or Bearer-token auth are exempt.
 *
 * @param {Object} [opts] -> Options.
 * @param {boolean} [opts.secure] -> Whether the cookie is Secure (default: NODE_ENV === 'production').
 * @returns {import('express').RequestHandler} -> The middleware.
 */
function csrfProtection({ secure = process.env.NODE_ENV === 'production' } = {}) {
  return function csrf(req, res, next) {
    const isStateMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isExempt = CSRF_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p));

    // Ensure every response carries a fresh CSRF cookie when absent.
    if (!req.cookies?.[CSRF_COOKIE]) {
      const token = crypto.randomBytes(32).toString('hex');
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false,
        sameSite: 'lax',
        secure,
        path: '/',
      });
      // Stash the token on the request so the check below works in the same cycle.
      req._csrfToken = token;
    } else {
      req._csrfToken = req.cookies[CSRF_COOKIE];
    }

    if (!isStateMutating || isExempt) return next();

    const headerToken = req.get(CSRF_HEADER);
    if (!headerToken || headerToken !== req._csrfToken) {
      res.status(403).json({ error: 'CSRF-Token fehlt oder ungültig.' });
      return;
    }

    next();
  };
}

module.exports = { csrfProtection, CSRF_COOKIE, CSRF_HEADER };
