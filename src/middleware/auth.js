'use strict';

const debug = require('debug');

const authService = require('../services/authService');

const log = debug('knowflow:middleware:auth');

/**
 * Resolves the session role of a request from its session cookie.
 *
 * @param {import('express').Request} req -> Request (expects req.cookies via cookie-parser).
 * @returns {string|null} -> SESSION_ROLES value, or null when unauthenticated.
 */
function getRole(req) {
  const token = req.cookies ? req.cookies[authService.COOKIE_NAME] : null;
  return authService.getSessionRole(token);
}

/**
 * Express middleware that rejects requests without a valid admin session cookie.
 * Mount it on every admin-only route except login/session probes.
 *
 * @param {import('express').Request} req -> Request.
 * @param {import('express').Response} res -> Response.
 * @param {import('express').NextFunction} next -> Next handler.
 * @returns {void}
 */
function requireAdmin(req, res, next) {
  if (getRole(req) === 'admin') {
    next();
    return;
  }
  log('requireAdmin rejected request to %s', req.originalUrl);
  res.status(401).json({ error: 'Nicht authentifiziert' });
}

/**
 * Express middleware that accepts any authenticated session (admin or user).
 *
 * @param {import('express').Request} req -> Request.
 * @param {import('express').Response} res -> Response.
 * @param {import('express').NextFunction} next -> Next handler.
 * @returns {void}
 */
function requireSession(req, res, next) {
  if (getRole(req)) {
    next();
    return;
  }
  log('requireSession rejected request to %s', req.originalUrl);
  res.status(401).json({ error: 'Nicht authentifiziert' });
}

module.exports = { requireAdmin, requireSession, getRole };
