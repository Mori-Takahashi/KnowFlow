'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// upsertEnv resolves the .env path from process.cwd() at module load time, so we
// chdir into an isolated temp directory BEFORE requiring it. This keeps the test
// from touching the project's real .env.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowflow-env-'));
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { upsertEnv, ENV_PATH, serializeValue } = require('../src/utils/envFile');

test.after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.afterEach(() => {
  try {
    fs.unlinkSync(ENV_PATH);
  } catch (_err) {
    /* ignore */
  }
});

test('upsertEnv creates a new .env when none exists', () => {
  const written = upsertEnv({ FOO: 'bar', PORT: '3000' });
  assert.deepEqual(written.sort(), ['FOO', 'PORT']);
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  assert.match(content, /^FOO=bar$/m);
  assert.match(content, /^PORT=3000$/m);
  // exactly one trailing newline
  assert.equal(content.endsWith('\n'), true);
  assert.equal(content.endsWith('\n\n'), false);
});

test('upsertEnv updates an existing key in place and preserves comments/order', () => {
  fs.writeFileSync(ENV_PATH, '# header comment\nFOO=old\nBAR=keep\n');
  upsertEnv({ FOO: 'new' });
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  assert.equal(lines[0], '# header comment');
  assert.equal(lines[1], 'FOO=new');
  assert.equal(lines[2], 'BAR=keep');
});

test('upsertEnv appends new keys without disturbing existing ones', () => {
  fs.writeFileSync(ENV_PATH, 'FOO=1\n');
  upsertEnv({ NEW_KEY: 'value' });
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  assert.match(content, /^FOO=1$/m);
  assert.match(content, /^NEW_KEY=value$/m);
});

test('upsertEnv is idempotent for unchanged values', () => {
  upsertEnv({ FOO: 'bar' });
  const first = fs.readFileSync(ENV_PATH, 'utf8');
  upsertEnv({ FOO: 'bar' });
  const second = fs.readFileSync(ENV_PATH, 'utf8');
  assert.equal(first, second);
});

test('serializeValue quotes values that contain spaces or special chars', () => {
  assert.equal(serializeValue('plain'), 'plain');
  assert.equal(serializeValue('with space'), '"with space"');
  assert.equal(serializeValue('a"b'), '"a\\"b"');
  assert.equal(serializeValue('has#hash'), '"has#hash"');
  assert.equal(serializeValue(''), '""');
});

test('upsertEnv ignores empty update maps', () => {
  assert.deepEqual(upsertEnv({}), []);
  assert.equal(fs.existsSync(ENV_PATH), false);
});
