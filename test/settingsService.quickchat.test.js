'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// A SETTINGS_ENCRYPTION_KEY must exist before settingsService/crypto load.
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef';

const { openDatabase } = require('../src/db');

// Fresh on-disk SQLite file; the db module caches the singleton so the whole
// file shares one initialized schema.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'knowflow-qc-')), 'test.sqlite');
openDatabase(dbPath);

const settingsService = require('../src/services/settingsService');

test('getQuickChatConfig returns defaults when unset', () => {
  const cfg = settingsService.getQuickChatConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.targetId, '');
  assert.deepEqual(cfg.allowedModels, []);
  assert.equal(cfg.systemPrompt, '');
  assert.equal(cfg.attachKnowledge, true);
});

test('setQuickChatConfig coerces and persists values', () => {
  settingsService.setQuickChatConfig({
    enabled: 'yes',
    targetId: '  kb-1  ',
    allowedModels: ['gpt-4', ' gpt-4 ', '', 'llama3'],
    systemPrompt: 'Du bist der Assistent.',
    attachKnowledge: 0,
  });
  const cfg = settingsService.getQuickChatConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.targetId, 'kb-1');
  // Trimmed, de-duplicated, empties removed.
  assert.deepEqual(cfg.allowedModels, ['gpt-4', 'llama3']);
  assert.equal(cfg.systemPrompt, 'Du bist der Assistent.');
  assert.equal(cfg.attachKnowledge, false);
});

test('setQuickChatConfig keeps existing values for omitted fields', () => {
  settingsService.setQuickChatConfig({ enabled: true, targetId: 'kb-2', allowedModels: ['m1'], systemPrompt: 'P', attachKnowledge: true });
  settingsService.setQuickChatConfig({ enabled: false });
  const cfg = settingsService.getQuickChatConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.targetId, 'kb-2');
  assert.deepEqual(cfg.allowedModels, ['m1']);
  assert.equal(cfg.systemPrompt, 'P');
  assert.equal(cfg.attachKnowledge, true);
});
