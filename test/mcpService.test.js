'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openDatabase, getDatabase } = require('../src/db');
const { createMcpService } = require('../src/services/mcpService');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

// Fresh on-disk SQLite file in the OS temp dir; the db module caches the
// singleton, so the whole test file shares one initialized schema.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'knowflow-test-')), 'test.sqlite');
openDatabase(dbPath);

/**
 * Seeds an MCP connection and (optionally) a ticket directly via SQL so the
 * tests control exactly what is in scope.
 */
function seedConnection(id, { allowFeedback }) {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO mcp_connections (id, title, description, is_all, require_auth, allow_feedback, created_at, updated_at)
       VALUES (?, ?, '', 1, 0, ?, ?, ?)`,
    )
    .run(id, id, allowFeedback ? 1 : 0, now, now);
  return getDatabase().prepare('SELECT * FROM mcp_connections WHERE id = ?').get(id);
}

function seedTicket(jiraId, reporterAccountId) {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO tickets (jira_id, project_key, summary, reporter_account_id, jira_status, overall_status, lifecycle, markdown, markdown_size, first_seen_at, updated_at)
       VALUES (?, 'KNOW', 'Beispiel', ?, 'Erledigt', 'done', 'active', '# Inhalt', 8, ?, ?)`,
    )
    .run(jiraId, reporterAccountId, now, now);
}

/** Builds a jiraService mock that records calls. */
function makeJiraMock() {
  const calls = { comments: [], transitions: [], transitionGets: [] };
  return {
    calls,
    addInaccuracyComment: async (issueKey, accountId, details, link) => {
      calls.comments.push({ issueKey, accountId, details, link });
    },
    getIssueTransitions: async (issueKey) => {
      calls.transitionGets.push(issueKey);
      return [{ id: '21', name: 'Überarbeiten', to: { name: 'Wird überarbeitet' } }];
    },
    transitionIssue: async (issueKey, transitionId) => {
      calls.transitions.push({ issueKey, transitionId });
    },
  };
}

const config = { publicBaseUrl: 'http://localhost:3000' };

/** Wires a built server to an in-memory client and returns the client. */
async function connectClient(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

test('report_inaccuracy posts a comment and moves the ticket into the rework status', async () => {
  const conn = seedConnection('fb-on', { allowFeedback: true });
  seedTicket('KNOW-100', 'acc-999');
  const jiraMock = makeJiraMock();
  const settingsStub = { getJiraConfig: () => ({ reworkStatuses: ['Wird überarbeitet'] }) };
  const mcp = createMcpService({ config, attachmentService: {}, jiraService: jiraMock, settingsService: settingsStub });

  const client = await connectClient(mcp.buildServer(conn));
  const res = await client.callTool({
    name: 'report_inaccuracy',
    arguments: { jiraId: 'KNOW-100', was_ist_falsch: 'Falsche Portnummer', korrektur: '8443' },
  });

  assert.equal(jiraMock.calls.comments.length, 1);
  assert.equal(jiraMock.calls.comments[0].issueKey, 'KNOW-100');
  assert.equal(jiraMock.calls.comments[0].accountId, 'acc-999');
  assert.equal(jiraMock.calls.comments[0].details.whatIsWrong, 'Falsche Portnummer');
  assert.equal(jiraMock.calls.transitions.length, 1);
  assert.equal(jiraMock.calls.transitions[0].transitionId, '21');
  assert.match(res.content[0].text, /KNOW-100/);
  assert.match(res.content[0].text, /verschoben/);

  // The activity feed received an entry.
  const ev = getDatabase().prepare("SELECT * FROM events WHERE jira_id = 'KNOW-100' ORDER BY id DESC").get();
  assert.ok(ev);
  assert.equal(ev.source, 'MCP');

  await client.close();
});

test('report_inaccuracy rejects a jiraId outside the connection scope', async () => {
  const conn = seedConnection('fb-scope', { allowFeedback: true });
  const jiraMock = makeJiraMock();
  const settingsStub = { getJiraConfig: () => ({ reworkStatuses: [] }) };
  const mcp = createMcpService({ config, attachmentService: {}, jiraService: jiraMock, settingsService: settingsStub });

  const client = await connectClient(mcp.buildServer(conn));
  const res = await client.callTool({
    name: 'report_inaccuracy',
    arguments: { jiraId: 'DOES-NOT-EXIST', was_ist_falsch: 'x' },
  });

  assert.equal(jiraMock.calls.comments.length, 0);
  assert.match(res.content[0].text, /nicht verfügbar/);
  await client.close();
});

test('report_inaccuracy is not registered when feedback is disabled', async () => {
  const conn = seedConnection('fb-off', { allowFeedback: false });
  const mcp = createMcpService({ config, attachmentService: {}, jiraService: makeJiraMock(), settingsService: { getJiraConfig: () => ({ reworkStatuses: [] }) } });

  const client = await connectClient(mcp.buildServer(conn));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);

  assert.ok(names.includes('search_knowledge'), 'read tools are present');
  assert.ok(!names.includes('report_inaccuracy'), 'write tool is gated off');
  await client.close();
});
