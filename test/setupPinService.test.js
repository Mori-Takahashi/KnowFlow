'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// setupPinService signs setup-session tokens with SESSION_SECRET (falling back to
// SETTINGS_ENCRYPTION_KEY). Ensure a secret exists before requiring it.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-für-setup';

const setupPinService = require('../src/services/setupPinService');

test.afterEach(() => {
  setupPinService.clearPin();
});

test('generatePin returns a fresh zero-padded 6-digit PIN', () => {
  const pin = setupPinService.generatePin();
  assert.match(pin, /^[0-9]{6}$/);
  assert.equal(setupPinService.getPin(), pin);
});

test('verifyPin matches only the active PIN (constant-time, exact length)', () => {
  const pin = setupPinService.generatePin();
  assert.equal(setupPinService.verifyPin(pin), true);
  assert.equal(setupPinService.verifyPin('000000' === pin ? '000001' : '000000'), false);
  assert.equal(setupPinService.verifyPin(pin.slice(0, 5)), false); // wrong length
  assert.equal(setupPinService.verifyPin(123456), false); // non-string
});

test('verifyPin fails once the PIN is cleared (setup completed)', () => {
  const pin = setupPinService.generatePin();
  setupPinService.clearPin();
  assert.equal(setupPinService.getPin(), null);
  assert.equal(setupPinService.verifyPin(pin), false);
});

test('issueSetupSession produces a token that verifySetupSession accepts', () => {
  const token = setupPinService.issueSetupSession();
  assert.equal(setupPinService.verifySetupSession(token), true);
});

test('verifySetupSession rejects tampered, malformed and empty tokens', () => {
  const token = setupPinService.issueSetupSession();
  assert.equal(setupPinService.verifySetupSession(token + 'x'), false);
  assert.equal(setupPinService.verifySetupSession('no-dot-here'), false);
  assert.equal(setupPinService.verifySetupSession(''), false);
  assert.equal(setupPinService.verifySetupSession(null), false);
});

test('verifySetupSession rejects an expired token', () => {
  // Craft a token with an exp in the past, signed with the same secret so only
  // the expiry check should fail.
  const crypto = require('node:crypto');
  const secret = process.env.SESSION_SECRET;
  const payload = { scope: 'setup', exp: Date.now() - 1000 };
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(segment).digest('base64url');
  assert.equal(setupPinService.verifySetupSession(`${segment}.${sig}`), false);
});

test('verifySetupSession rejects a valid signature with the wrong scope', () => {
  const crypto = require('node:crypto');
  const secret = process.env.SESSION_SECRET;
  const payload = { scope: 'admin', exp: Date.now() + 60000 };
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(segment).digest('base64url');
  assert.equal(setupPinService.verifySetupSession(`${segment}.${sig}`), false);
});
