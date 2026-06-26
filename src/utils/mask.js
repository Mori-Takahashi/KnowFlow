'use strict';

const debug = require('debug');

const log = debug('knowflow:utils:mask');

/**
 * Masks a secret-like string so it can be safely written to logs.
 *
 * Keeps the first `head` and last `tail` characters and replaces the middle
 * with three dots. Short strings (length <= head + tail) are fully masked
 * with asterisks so we never reveal more than half of the secret.
 *
 * @param {string|undefined|null} value -> The secret to mask.
 * @param {number} [head=4] -> Number of leading characters to keep.
 * @param {number} [tail=4] -> Number of trailing characters to keep.
 * @returns {string} -> Masked representation, or an empty string when value is falsy.
 * @example
 * maskSecret('abcdef1234567890', 4, 4); // -> 'abcd...7890'
 */
function maskSecret(value, head = 4, tail = 4) {
  log('maskSecret called');
  if (!value) return '';
  const str = String(value);
  if (str.length <= head + tail) {
    return '*'.repeat(str.length);
  }
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

/**
 * Returns a shallow copy of an object with the given keys masked using
 * `maskSecret`. Non-string values are converted to strings before masking.
 *
 * @param {Object|undefined|null} obj -> Source object (e.g. req.query).
 * @param {string[]} keys -> Keys whose values should be masked.
 * @returns {Object} -> A new object with the requested keys masked.
 * @example
 * maskInBody({ secret: 'abcdef1234', other: 'x' }, ['secret']);
 * // -> { secret: 'abcd...1234', other: 'x' }
 */
function maskInBody(obj, keys) {
  log('maskInBody called with keys=%o', keys);
  if (!obj || typeof obj !== 'object') return {};
  const copy = { ...obj };
  for (const key of keys) {
    if (copy[key] !== undefined && copy[key] !== null && copy[key] !== '') {
      copy[key] = maskSecret(copy[key]);
    }
  }
  return copy;
}

module.exports = { maskSecret, maskInBody };
