'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Stub axios so jiraService talks to an in-memory fake instead of the network.
// The fake records every request and returns canned responses keyed by method.
const calls = [];
let transitionsResponse = { data: { transitions: [] } };

const fakeClient = {
  async get(url, opts) {
    calls.push({ method: 'get', url, opts });
    if (url.endsWith('/transitions')) return transitionsResponse;
    return { data: {} };
  },
  async post(url, body) {
    calls.push({ method: 'post', url, body });
    return { data: { id: '10000' } };
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'axios') {
    return { create: () => fakeClient };
  }
  return originalLoad(request, parent, isMain);
};

const { createJiraService } = require('../src/services/jiraService');

const settingsStub = {
  getJiraConfig: () => ({
    baseUrl: 'https://example.atlassian.net',
    email: 'a@b.c',
    apiToken: 'token',
  }),
};

const jira = createJiraService(settingsStub);

test.afterEach(() => {
  calls.length = 0;
  transitionsResponse = { data: { transitions: [] } };
});

test('addInaccuracyComment posts a multi-paragraph ADF with mention and correction', async () => {
  await jira.addInaccuracyComment(
    'KNOW-1',
    'acc-123',
    { whatIsWrong: 'Die Portnummer ist falsch', correction: 'Richtig ist 8443' },
    { label: 'Dashboard', url: 'http://localhost:3000/?ticket=KNOW-1' },
  );

  const call = calls.find((c) => c.method === 'post');
  assert.ok(call, 'a POST request was made');
  assert.equal(call.url, '/rest/api/3/issue/KNOW-1/comment');

  const doc = call.body.body;
  assert.equal(doc.type, 'doc');
  // intro (with mention) + what + correction + link = 4 paragraphs
  assert.equal(doc.content.length, 4);
  assert.equal(doc.content[0].content[0].type, 'mention');
  assert.equal(doc.content[0].content[0].attrs.id, 'acc-123');

  const flat = JSON.stringify(doc);
  assert.match(flat, /Die Portnummer ist falsch/);
  assert.match(flat, /Richtig ist 8443/);
  // trailing link carries the dashboard URL
  assert.match(flat, /localhost:3000/);
});

test('addInaccuracyComment omits mention and correction when not provided', async () => {
  await jira.addInaccuracyComment(
    'KNOW-2',
    null,
    { whatIsWrong: 'Stimmt nicht' },
    { label: 'Dashboard', url: 'http://x/?ticket=KNOW-2' },
  );

  const doc = calls.find((c) => c.method === 'post').body.body;
  // no mention paragraph extra, no correction paragraph -> intro + what + link
  assert.equal(doc.content.length, 3);
  assert.notEqual(doc.content[0].content[0].type, 'mention');
});

test('getIssueTransitions returns the transitions array', async () => {
  transitionsResponse = {
    data: { transitions: [{ id: '21', name: 'Überarbeiten', to: { name: 'Wird überarbeitet' } }] },
  };
  const result = await jira.getIssueTransitions('KNOW-3');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '21');
  assert.equal(calls[0].url, '/rest/api/3/issue/KNOW-3/transitions');
});

test('transitionIssue posts the transition id', async () => {
  await jira.transitionIssue('KNOW-4', '21');
  const call = calls.find((c) => c.method === 'post');
  assert.equal(call.url, '/rest/api/3/issue/KNOW-4/transitions');
  assert.deepEqual(call.body, { transition: { id: '21' } });
});
