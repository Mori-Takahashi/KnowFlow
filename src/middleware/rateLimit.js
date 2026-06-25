'use strict';

const debug = require('debug');

const log = debug('knowflow:middleware:rateLimit');

/**
 * Creates a simple in-memory fixed-window rate limiter keyed by client IP.
 * Intended for low-volume, security-sensitive endpoints (login, OAuth) on a
 * single-instance deployment — it deliberately avoids an external store. For a
 * correct client IP behind a proxy, the app must enable `trust proxy`.
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
  const hits = new Map(); // ip -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    // Opportunistic cleanup so the map cannot grow unbounded under churn.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.resetAt <= now) hits.delete(k);
      }
    }

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      log('rate limit hit for %s on %s', key, req.originalUrl);
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

module.exports = { createRateLimiter };
