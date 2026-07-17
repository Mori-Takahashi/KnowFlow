'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// oauthService signs artifacts with the session secret; provide one before it
// (indirectly, via the router) is required.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-oauth-redirect';

const { openDatabase, getDatabase } = require('../src/db');

// Fresh on-disk SQLite file; the db module caches the singleton so the whole
// test file shares one initialized schema.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'knowflow-oauth-test-')), 'test.sqlite');
openDatabase(dbPath);

const express = require('express');
const { createOAuthRouter } = require('../src/routes/oauth');
const oauthService = require('../src/services/oauthService');

const config = { publicBaseUrl: 'http://localhost:3000' };

/** Seeds an MCP connection so the authorize resource check can resolve it. */
function seedConnection(id) {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO mcp_connections (id, title, description, is_all, require_auth, allow_feedback, created_at, updated_at)
       VALUES (?, ?, '', 1, 0, 0, ?, ?)`,
    )
    .run(id, id, now, now);
}

/** Builds a throwaway express app that mounts only the OAuth router. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createOAuthRouter({ config, authService: {} }));
  return app;
}

/** Runs `fn(baseUrl)` against an ephemeral server, then tears it down. */
async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Valid PKCE + authorize query params, overridable per test. */
function authorizeQuery(overrides) {
  return new URLSearchParams({
    response_type: 'code',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: 'http://localhost:3000/mcp/mcp-auth',
    ...overrides,
  }).toString();
}

// ---- /oauth/register ------------------------------------------------------

test('register rejects a javascript: redirect_uri before issuing a client_id', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_redirect_uri');
    assert.equal(body.client_id, undefined);
  });
});

test('register rejects data:, file: and plain http on a non-loopback host', async () => {
  await withServer(async (base) => {
    for (const uri of ['data:text/html,x', 'file:///etc/passwd', 'http://evil.example.com/cb']) {
      const res = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      assert.equal(res.status, 400, `expected 400 for ${uri}`);
      const body = await res.json();
      assert.equal(body.error, 'invalid_redirect_uri', `expected invalid_redirect_uri for ${uri}`);
    }
  });
});

test('register rejects the whole request if any redirect_uri has a bad scheme', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://good.example.com/cb', 'javascript:alert(1)'] }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_redirect_uri');
  });
});

test('register accepts absolute https and http on localhost/127.0.0.1', async () => {
  await withServer(async (base) => {
    const redirect_uris = ['https://app.example.com/cb', 'http://localhost:3000/cb', 'http://127.0.0.1:8080/cb'];
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.client_id && body.client_id.startsWith('kfc_'), 'a client_id is issued');
    assert.deepEqual(body.redirect_uris, redirect_uris);
  });
});

// ---- /oauth/authorize (defence in depth) ----------------------------------

test('authorize rejects a registered redirect_uri whose scheme is not allowed', async () => {
  // Mint a client_id that statelessly encodes a bad redirect_uri, simulating a
  // value that slipped into an issued client id before validation existed.
  const clientId = oauthService.issueClientId(['javascript:alert(1)']);
  await withServer(async (base) => {
    const query = authorizeQuery({ client_id: clientId, redirect_uri: 'javascript:alert(1)' });
    const res = await fetch(`${base}/oauth/authorize?${query}`);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /unzulässiges Schema/);
  });
});

test('authorize accepts a valid https redirect_uri and renders the login page', async () => {
  seedConnection('mcp-auth');
  const clientId = oauthService.issueClientId(['https://app.example.com/cb']);
  await withServer(async (base) => {
    const query = authorizeQuery({ client_id: clientId, redirect_uri: 'https://app.example.com/cb' });
    const res = await fetch(`${base}/oauth/authorize?${query}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /unzulässiges Schema/);
    assert.match(html, /autorisieren/);
  });
});
