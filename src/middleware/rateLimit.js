'use strict';

const { rateLimit } = require('express-rate-limit');
const debug = require('debug');

const log = debug('knowflow:middleware:rateLimit');

/**
 * Creates an in-memory fixed-window rate limiter keyed by client IP, backed by
 * express-rate-limit. Intended for security-sensitive endpoints (login, OAuth)
 * on a single-instance deployment. For a correct client IP behind a proxy, the
 * app must enable `trust proxy`.
 *
 * @param {Object} [opts] -> Options.
 * @param {number} [opts.windowMs=900000] -> Window length in ms (default 15 min).
 * @param {number} [opts.max=10] -> Allowed requests per window per IP.
 * @param {string} [opts.message] -> Error message returned on HTTP 429.
 * @returns {import('express').RequestHandler} -> The limiter middleware.
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 10,
  message = 'Zu viele Versuche. Bitte später erneut versuchen.',
} = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler(req, res) {
      const resetTime = req.rateLimit?.resetTime;
      const retryAfter = resetTime
        ? Math.ceil((resetTime.getTime() - Date.now()) / 1000)
        : Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(retryAfter));
      log('rate limit hit for %s on %s', req.ip, req.originalUrl);
      res.status(429).json({ error: message });
    },
  });
}

module.exports = { createRateLimiter };
