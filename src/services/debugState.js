'use strict';

const debug = require('debug');

const log = debug('knowflow:debugState');

/**
 * Holds the runtime state for UI debug mode (only active when UI_DEBUG=true).
 *
 * Two pieces of state live here:
 *   1. Health overrides: a map service -> forced status, so the presenter can
 *      make a service appear 'down' or 'warn' in the dashboard on demand.
 *   2. A cache-invalidation hook registered by the /api/health route, so a
 *      health override takes effect immediately instead of after the cache TTL.
 *
 * This module is a process-wide singleton; the debug route mutates it and the
 * api route reads it. It is intentionally tiny and dependency-free.
 */

// service ('knowflow'|'openwebui'|'jira') -> status ('up'|'warn'|'down')
let healthOverrides = {};

// Replaced by the api route with a function that clears its health cache.
let invalidateHealthCache = () => {};

/**
 * Sets or clears a forced health status for a single service.
 *
 * @param {string} service -> Service key ('knowflow'|'openwebui'|'jira').
 * @param {string|null} status -> Forced status, or null/empty to clear.
 * @returns {void}
 */
function setHealthOverride(service, status) {
  log('setHealthOverride called with: %o', { service, status });
  if (!status) {
    delete healthOverrides[service];
  } else {
    healthOverrides[service] = status;
  }
}

/**
 * Returns a shallow copy of the current health overrides.
 *
 * @returns {Object} -> Map of service -> forced status.
 */
function getHealthOverrides() {
  return { ...healthOverrides };
}

/**
 * Clears all health overrides.
 *
 * @returns {void}
 */
function clearHealthOverrides() {
  log('clearHealthOverrides called');
  healthOverrides = {};
}

/**
 * Registers the function used to invalidate the health-response cache so an
 * override change is reflected on the next request.
 *
 * @param {Function} fn -> Invalidator supplied by the api route.
 * @returns {void}
 */
function registerHealthCacheInvalidator(fn) {
  log('registerHealthCacheInvalidator called');
  invalidateHealthCache = typeof fn === 'function' ? fn : () => {};
}

/**
 * Invokes the registered cache invalidator. No-op if none registered.
 *
 * @returns {void}
 */
function invalidate() {
  log('invalidate called');
  invalidateHealthCache();
}

module.exports = {
  setHealthOverride,
  getHealthOverrides,
  clearHealthOverrides,
  registerHealthCacheInvalidator,
  invalidate,
};
