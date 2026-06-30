'use strict';

const fs = require('fs');
const path = require('path');
const debug = require('debug');

const log = debug('knowflow:utils:envFile');

// Absolute path to the project-root .env. Resolved from cwd, matching how
// dotenv loads it in src/index.js (require('dotenv').config()).
const ENV_PATH = path.resolve(process.cwd(), '.env');

/**
 * Quotes an .env value when it contains characters that would otherwise break
 * single-line parsing (whitespace, quotes, #, =, backslash, newlines). Plain
 * values are written verbatim so existing files stay human-readable.
 *
 * @param {string} value -> Raw value to serialize.
 * @returns {string} -> The value, double-quoted and escaped when necessary.
 */
function serializeValue(value) {
  const str = String(value == null ? '' : value);
  if (str === '' || /[\s"'#=\\]/.test(str)) {
    const escaped = str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    return `"${escaped}"`;
  }
  return str;
}

/**
 * Reads the .env file and returns its raw lines. Returns an empty array when the
 * file does not exist yet.
 *
 * @returns {string[]} -> The current lines of the .env (without trailing newline).
 */
function readLines() {
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    // Drop a single trailing newline so we don't accumulate blank lines on each
    // rewrite; intermediate blank lines/comments are preserved as-is.
    return raw.replace(/\n$/, '').split('\n');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Returns the KEY of an .env assignment line, or null for comments/blanks.
 *
 * @param {string} line -> A single .env line.
 * @returns {string|null} -> The key, or null when the line is not an assignment.
 */
function lineKey(line) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match ? match[1] : null;
}

/**
 * Merges the given key/value updates into the project-root .env file, preserving
 * existing lines, comments, and ordering. Keys already present are updated
 * in-place; new keys are appended. The write is atomic (temp file + rename) so a
 * crash mid-write cannot corrupt an existing .env.
 *
 * @param {Object<string, string>} updates -> Map of env keys to values.
 * @returns {string[]} -> The keys that were actually written.
 */
function upsertEnv(updates) {
  log('upsertEnv called with keys %o', Object.keys(updates || {}));
  const entries = Object.entries(updates || {}).filter(([key]) => key);
  if (entries.length === 0) return [];

  const lines = readLines();
  const remaining = new Map(entries.map(([k, v]) => [k, v]));

  // Update existing assignments in place.
  const nextLines = lines.map((line) => {
    const key = lineKey(line);
    if (key && remaining.has(key)) {
      const value = remaining.get(key);
      remaining.delete(key);
      return `${key}=${serializeValue(value)}`;
    }
    return line;
  });

  // Append any keys that were not already present.
  for (const [key, value] of remaining) {
    nextLines.push(`${key}=${serializeValue(value)}`);
  }

  const output = `${nextLines.join('\n')}\n`;
  const tmpPath = `${ENV_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, output, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, ENV_PATH);

  return entries.map(([key]) => key);
}

module.exports = { upsertEnv, ENV_PATH, serializeValue };
