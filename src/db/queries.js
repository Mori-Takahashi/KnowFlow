'use strict';

const debug = require('debug');

const { getDatabase } = require('./index');
const { STEP_STATUS, TICKET_STATUS } = require('../constants');

const log = debug('knowflow:db:queries');

/**
 * Inserts or updates a ticket record. Preserves first_seen_at on update.
 *
 * @param {Object} ticket -> Ticket fields to upsert.
 * @param {string} ticket.jiraId -> The Jira issue key.
 * @param {string} ticket.projectKey -> Jira project key.
 * @param {string} ticket.summary -> Issue summary.
 * @param {string|null} ticket.priority -> Priority name.
 * @param {string|null} ticket.assignee -> Assignee display name.
 * @param {string|null} ticket.reporter -> Reporter display name.
 * @param {string|null} ticket.reporterAccountId -> Reporter accountId for Jira mentions.
 * @param {string|null} ticket.jiraStatus -> Current Jira status name.
 * @param {string} ticket.overallStatus -> One of TICKET_STATUS values.
 * @returns {void}
 */
function upsertTicket(ticket) {
  log('upsertTicket called with: %o', { jiraId: ticket.jiraId, overallStatus: ticket.overallStatus });
  const now = Date.now();
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO tickets (
      jira_id, project_key, summary, priority, assignee, reporter,
      reporter_account_id, jira_status, overall_status, first_seen_at, updated_at
    )
    VALUES (
      @jiraId, @projectKey, @summary, @priority, @assignee, @reporter,
      @reporterAccountId, @jiraStatus, @overallStatus, @now, @now
    )
    ON CONFLICT(jira_id) DO UPDATE SET
      project_key         = excluded.project_key,
      summary             = excluded.summary,
      priority            = excluded.priority,
      assignee            = excluded.assignee,
      reporter            = excluded.reporter,
      reporter_account_id = excluded.reporter_account_id,
      jira_status         = excluded.jira_status,
      overall_status      = excluded.overall_status,
      updated_at          = @now
  `);
  stmt.run({ ...ticket, now });
}

/**
 * Updates the markdown content + size for a ticket.
 *
 * @param {string} jiraId -> The Jira issue key.
 * @param {string} markdown -> Generated markdown content.
 * @returns {void}
 */
function updateTicketMarkdown(jiraId, markdown) {
  log('updateTicketMarkdown called with: %o', { jiraId, length: markdown.length });
  const db = getDatabase();
  const size = Buffer.byteLength(markdown, 'utf8');
  db.prepare(
    'UPDATE tickets SET markdown = ?, markdown_size = ?, updated_at = ? WHERE jira_id = ?',
  ).run(markdown, size, Date.now(), jiraId);
}

/**
 * Stores a freshly computed embedding for a ticket and marks it as done. Does
 * not touch updated_at so a reindex of old tickets never reorders the list.
 *
 * @param {string} jiraId -> The Jira issue key.
 * @param {Buffer} blob -> The Float32 embedding serialized to a Buffer.
 * @param {string} model -> Model tag the embedding was produced with (e.g. 'ollama:nomic-embed-text').
 * @param {number} dim -> Vector dimension.
 * @returns {void}
 */
function updateTicketEmbedding(jiraId, blob, model, dim) {
  log('updateTicketEmbedding called with: %o', { jiraId, model, dim });
  const db = getDatabase();
  db.prepare(
    "UPDATE tickets SET embedding = ?, embedding_model = ?, embedding_dim = ?, embedding_status = 'done' WHERE jira_id = ?",
  ).run(blob, model, dim, jiraId);
}

/**
 * Updates only the embedding status of a ticket (e.g. to 'failed' when an
 * embedding attempt errored). The stored vector, if any, is left intact.
 *
 * @param {string} jiraId -> The Jira issue key.
 * @param {string} status -> One of EMBEDDING_STATUS values.
 * @returns {void}
 */
function setTicketEmbeddingStatus(jiraId, status) {
  log('setTicketEmbeddingStatus called with: %o', { jiraId, status });
  const db = getDatabase();
  db.prepare('UPDATE tickets SET embedding_status = ? WHERE jira_id = ?').run(status, jiraId);
}

/**
 * Returns active tickets that need (re-)embedding for the given model tag:
 * those with markdown but no usable embedding for that exact model. Used by the
 * background reindex job after enabling RAG or switching the embedding model.
 *
 * @param {string} model -> Current model tag.
 * @returns {Object[]} -> Rows with jira_id, summary, markdown.
 */
function listTicketsForEmbedding(model) {
  log('listTicketsForEmbedding called with: %o', { model });
  const db = getDatabase();
  return db
    .prepare(`
      SELECT jira_id, summary, markdown
      FROM tickets
      WHERE lifecycle = 'active' AND markdown IS NOT NULL
        AND (embedding IS NULL OR embedding_model IS NOT @model)
      ORDER BY updated_at DESC
    `)
    .all({ model });
}

/**
 * Returns embedding coverage stats for active tickets, for the given model tag.
 *
 * @param {string} model -> Current model tag.
 * @returns {{total: number, embedded: number, failed: number}} -> Aggregate counts.
 */
function getEmbeddingStats(model) {
  log('getEmbeddingStats called with: %o', { model });
  const db = getDatabase();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN embedding IS NOT NULL AND embedding_model IS @model THEN 1 ELSE 0 END), 0) AS embedded,
        COALESCE(SUM(CASE WHEN embedding_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
      FROM tickets
      WHERE lifecycle = 'active' AND markdown IS NOT NULL
    `)
    .get({ model });
  return { total: row.total, embedded: row.embedded, failed: row.failed };
}

/**
 * Sets the Open WebUI file UUID for a ticket.
 *
 * @param {string} jiraId -> The Jira issue key.
 * @param {string} uuid -> The Open WebUI file UUID.
 * @returns {void}
 */
function setTicketOpenWebUiUuid(jiraId, uuid) {
  log('setTicketOpenWebUiUuid called with: %o', { jiraId, uuid });
  const db = getDatabase();
  db.prepare('UPDATE tickets SET openwebui_uuid = ?, updated_at = ? WHERE jira_id = ?').run(
    uuid,
    Date.now(),
    jiraId,
  );
}

/**
 * Sets the overall status of a ticket.
 *
 * @param {string} jiraId -> The Jira issue key.
 * @param {string} overallStatus -> One of TICKET_STATUS values.
 * @returns {void}
 */
function setTicketOverallStatus(jiraId, overallStatus) {
  log('setTicketOverallStatus called with: %o', { jiraId, overallStatus });
  const db = getDatabase();
  db.prepare('UPDATE tickets SET overall_status = ?, updated_at = ? WHERE jira_id = ?').run(
    overallStatus,
    Date.now(),
    jiraId,
  );
}

/**
 * Fetches a ticket by its Jira key.
 *
 * @param {string} jiraId -> The Jira issue key.
 * @returns {Object|null} -> The ticket row, or null if not found.
 */
function getTicket(jiraId) {
  log('getTicket called with: %o', { jiraId });
  const db = getDatabase();
  return db.prepare('SELECT * FROM tickets WHERE jira_id = ?').get(jiraId) ?? null;
}

/**
 * Counts tickets, optionally filtered by overall status.
 *
 * @param {Object} options -> Filter options.
 * @param {string|null} [options.status] -> Restrict to one TICKET_STATUS value.
 * @param {string} [options.query] -> Substring to match against summary or jira_id.
 * @returns {number} -> Number of matching tickets.
 */
function countTickets({ status = null, query = '' } = {}) {
  const db = getDatabase();
  const where = [];
  const params = {};
  if (status && status !== 'all') {
    where.push('overall_status = @status');
    params.status = status;
  }
  if (query) {
    where.push('(LOWER(summary) LIKE @q OR LOWER(jira_id) LIKE @q)');
    params.q = `%${query.toLowerCase()}%`;
  }
  const sql = `SELECT COUNT(*) AS n FROM tickets${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  const row = db.prepare(sql).get(params);
  return row.n;
}

/**
 * Returns paginated tickets joined with their latest workflow_run.
 *
 * @param {Object} options -> Query options.
 * @param {number} options.limit -> Max rows.
 * @param {number} options.offset -> Skip rows.
 * @param {string|null} [options.status] -> Optional overall status filter.
 * @param {string} [options.query] -> Optional substring filter.
 * @returns {Object[]} -> Joined rows.
 */
function listTickets({ limit, offset, status = null, query = '' }) {
  log('listTickets called with: %o', { limit, offset, status, query });
  const db = getDatabase();
  const where = [];
  const params = { limit, offset };
  if (status && status !== 'all') {
    where.push('t.overall_status = @status');
    params.status = status;
  }
  if (query) {
    where.push('(LOWER(t.summary) LIKE @q OR LOWER(t.jira_id) LIKE @q)');
    params.q = `%${query.toLowerCase()}%`;
  }
  const sql = `
    SELECT t.*,
           w.step_1_status, w.step_1_sub, w.step_1_at,
           w.step_2_status, w.step_2_sub, w.step_2_at,
           w.step_3_status, w.step_3_sub, w.step_3_at,
           w.error AS run_error,
           w.started_at AS run_started_at,
           w.finished_at AS run_finished_at
    FROM tickets t
    LEFT JOIN workflow_runs w ON w.jira_id = t.jira_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.updated_at DESC
    LIMIT @limit OFFSET @offset
  `;
  return db.prepare(sql).all(params);
}

/**
 * Counts tickets grouped by overall_status, for filter chips.
 *
 * @returns {Object} -> Map of status -> count, including 'all'.
 */
function countTicketsByStatus() {
  log('countTicketsByStatus called');
  const db = getDatabase();
  const rows = db
    .prepare('SELECT overall_status AS s, COUNT(*) AS n FROM tickets GROUP BY overall_status')
    .all();
  const out = { all: 0 };
  for (const row of rows) {
    out[row.s] = row.n;
    out.all += row.n;
  }
  for (const key of Object.values(TICKET_STATUS)) {
    if (out[key] == null) out[key] = 0;
  }
  return out;
}

/**
 * Inserts or resets a workflow_runs row for the ticket. All steps set to idle.
 *
 * @param {string} jiraId -> Issue key.
 * @returns {void}
 */
function resetWorkflowRun(jiraId) {
  log('resetWorkflowRun called with: %o', { jiraId });
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`
    INSERT INTO workflow_runs (
      jira_id, step_1_status, step_2_status, step_3_status, started_at, finished_at, error
    )
    VALUES (@jiraId, 'idle', 'idle', 'idle', @now, NULL, NULL)
    ON CONFLICT(jira_id) DO UPDATE SET
      step_1_status = 'idle', step_1_sub = NULL, step_1_at = NULL,
      step_2_status = 'idle', step_2_sub = NULL, step_2_at = NULL,
      step_3_status = 'idle', step_3_sub = NULL, step_3_at = NULL,
      error = NULL,
      started_at = @now,
      finished_at = NULL
  `).run({ jiraId, now });
}

/**
 * Sets the status, optional sub-text, and timestamp of a single workflow step.
 *
 * @param {string} jiraId -> Issue key.
 * @param {number} stepIndex -> 0-based step index (0..2).
 * @param {string} status -> One of STEP_STATUS values.
 * @param {string|null} [sub] -> Optional sub-line for the WebUI.
 * @returns {void}
 * @throws {Error} -> If stepIndex is out of range.
 */
function setStepStatus(jiraId, stepIndex, status, sub = null) {
  log('setStepStatus called with: %o', { jiraId, stepIndex, status, sub });
  if (stepIndex < 0 || stepIndex > 2) {
    throw new Error(`Ungültiger stepIndex: ${stepIndex}`);
  }
  const n = stepIndex + 1;
  const db = getDatabase();
  const sql = `
    UPDATE workflow_runs
    SET step_${n}_status = ?, step_${n}_sub = ?, step_${n}_at = ?
    WHERE jira_id = ?
  `;
  db.prepare(sql).run(status, sub, Date.now(), jiraId);
}

/**
 * Marks the workflow run as finished and optionally stores an error message.
 *
 * @param {string} jiraId -> Issue key.
 * @param {string|null} [errorMessage] -> Optional error description.
 * @returns {void}
 */
function finishWorkflowRun(jiraId, errorMessage = null) {
  log('finishWorkflowRun called with: %o', { jiraId, errorMessage });
  const db = getDatabase();
  db.prepare(
    'UPDATE workflow_runs SET finished_at = ?, error = ? WHERE jira_id = ?',
  ).run(Date.now(), errorMessage, jiraId);
}

/**
 * Reads the workflow_runs row for a ticket.
 *
 * @param {string} jiraId -> Issue key.
 * @returns {Object|null} -> The row, or null.
 */
function getWorkflowRun(jiraId) {
  log('getWorkflowRun called with: %o', { jiraId });
  const db = getDatabase();
  return db.prepare('SELECT * FROM workflow_runs WHERE jira_id = ?').get(jiraId) ?? null;
}

/**
 * Inserts an activity event.
 *
 * @param {Object} event -> Event fields.
 * @param {string} event.kind -> ACTIVITY_KIND value.
 * @param {string|null} event.jiraId -> Optional Jira issue key.
 * @param {string} event.title -> Short title.
 * @param {string|null} [event.detail] -> Optional detail line.
 * @param {string} [event.source] -> Optional source label.
 * @returns {Object} -> The inserted event row including id and created_at.
 */
function insertEvent({ kind, jiraId = null, title, detail = null, source = 'System' }) {
  log('insertEvent called with: %o', { kind, jiraId, title });
  const db = getDatabase();
  const now = Date.now();
  const result = db
    .prepare(
      'INSERT INTO events (kind, jira_id, title, detail, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(kind, jiraId, title, detail, source, now);
  return { id: result.lastInsertRowid, kind, jiraId, title, detail, source, createdAt: now };
}

/**
 * Returns the most recent events, newest first.
 *
 * @param {number} limit -> Max rows.
 * @returns {Object[]} -> Event rows.
 */
function listEvents(limit = 50) {
  log('listEvents called with: %o', { limit });
  const db = getDatabase();
  return db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit);
}

/**
 * Aggregates per-day counts for the last `days` days, by event kind.
 * Used for the throughput chart on the dashboard.
 *
 * @param {number} days -> Lookback window in days.
 * @returns {Object[]} -> One entry per day with ok/err/rw counts.
 */
function throughputByDay(days = 7) {
  log('throughputByDay called with: %o', { days });
  const db = getDatabase();
  const dayLabels = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const out = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const dayStart = d.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    const rows = db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM events
         WHERE created_at >= ? AND created_at < ?
         GROUP BY kind`,
      )
      .all(dayStart, dayEnd);

    const counts = { ok: 0, err: 0, rw: 0 };
    for (const r of rows) {
      if (r.kind === 'ok') counts.ok = r.n;
      else if (r.kind === 'err') counts.err = r.n;
      else if (r.kind === 'rework') counts.rw = r.n;
    }
    out.push({ day: dayLabels[d.getDay()], ...counts });
  }
  return out;
}

/**
 * Returns counts of tickets that have at least progressed past each step.
 * Used for the workflow funnel on the dashboard.
 *
 * @returns {Object[]} -> Funnel entries with step, name, count.
 */
function funnelCounts() {
  log('funnelCounts called');
  const db = getDatabase();
  const total = db
    .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE step_1_status IN ('done','work','err')")
    .get().n;
  const step2 = db
    .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE step_2_status IN ('done','work','err')")
    .get().n;
  const step3 = db
    .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE step_3_status IN ('done','work','err')")
    .get().n;
  return [
    { step: 1, name: 'Aus Jira laden', count: total },
    { step: 2, name: 'Markdown speichern', count: step2 },
    { step: 3, name: 'OpenWebUI Upload', count: step3 },
  ];
}

/**
 * Stats used by the dashboard tiles.
 *
 * @returns {Object} -> totalProcessed, inProgress, errors, rework, thisWeek, knowledgeBytes.
 */
function getDashboardStats() {
  log('getDashboardStats called');
  const db = getDatabase();

  const totalProcessed = db
    .prepare("SELECT COUNT(*) AS n FROM tickets WHERE overall_status = 'done'")
    .get().n;
  const inProgress = db
    .prepare("SELECT COUNT(*) AS n FROM tickets WHERE overall_status = 'work'")
    .get().n;
  const errors = db
    .prepare("SELECT COUNT(*) AS n FROM tickets WHERE overall_status = 'err'")
    .get().n;
  const rework = db
    .prepare("SELECT COUNT(*) AS n FROM tickets WHERE overall_status = 'rework'")
    .get().n;

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = db
    .prepare('SELECT COUNT(*) AS n FROM tickets WHERE first_seen_at >= ?')
    .get(weekAgo).n;

  const sizeRow = db
    .prepare("SELECT COALESCE(SUM(markdown_size), 0) AS bytes FROM tickets WHERE markdown_size > 0")
    .get();
  const knowledgeBytes = sizeRow.bytes;

  return { totalProcessed, inProgress, errors, rework, thisWeek, knowledgeBytes };
}

/**
 * Inserts a new dummy file record for the local Open WebUI mock.
 *
 * @param {Object} args -> File arguments.
 * @param {string} args.uuid -> Generated UUID.
 * @param {string} args.jiraId -> Owning Jira issue key.
 * @param {string} args.content -> Markdown content.
 * @returns {void}
 */
function insertDummyFile({ uuid, jiraId, content }) {
  log('insertDummyFile called with: %o', { uuid, jiraId });
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    'INSERT INTO openwebui_dummy_files (uuid, jira_id, content, in_knowledge, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
  ).run(uuid, jiraId, content, now, now);
}

/**
 * Overwrites the content of an existing dummy file. Mirrors the Open WebUI
 * "content update" endpoint behavior.
 *
 * @param {string} uuid -> The file UUID.
 * @param {string} content -> New markdown content.
 * @returns {boolean} -> True if a row was updated.
 */
function updateDummyFileContent(uuid, content) {
  log('updateDummyFileContent called with: %o', { uuid, length: content.length });
  const db = getDatabase();
  const info = db
    .prepare('UPDATE openwebui_dummy_files SET content = ?, updated_at = ? WHERE uuid = ?')
    .run(content, Date.now(), uuid);
  return info.changes > 0;
}

/**
 * Marks a dummy file as part of the knowledge base.
 *
 * @param {string} uuid -> File UUID.
 * @returns {void}
 */
function markDummyFileInKnowledge(uuid) {
  log('markDummyFileInKnowledge called with: %o', { uuid });
  const db = getDatabase();
  db.prepare('UPDATE openwebui_dummy_files SET in_knowledge = 1, updated_at = ? WHERE uuid = ?').run(
    Date.now(),
    uuid,
  );
}

/**
 * Returns a dummy file row by uuid.
 *
 * @param {string} uuid -> File UUID.
 * @returns {Object|null} -> The row or null.
 */
function getDummyFile(uuid) {
  log('getDummyFile called with: %o', { uuid });
  const db = getDatabase();
  return db.prepare('SELECT * FROM openwebui_dummy_files WHERE uuid = ?').get(uuid) ?? null;
}

// ---------------------------------------------------------------------------
// Settings (key/value store, value is a JSON string)
// ---------------------------------------------------------------------------

/**
 * Reads a raw settings value (JSON string) by key.
 *
 * @param {string} key -> Settings key.
 * @returns {string|null} -> Raw JSON string, or null if absent.
 */
function getSetting(key) {
  log('getSetting called with: %o', { key });
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Inserts or updates a settings value. The caller passes an already-serialized
 * JSON string.
 *
 * @param {string} key -> Settings key.
 * @param {string} value -> JSON string value.
 * @returns {void}
 */
function setSetting(key, value) {
  log('setSetting called with: %o', { key });
  const db = getDatabase();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

// ---------------------------------------------------------------------------
// Knowledge targets (OpenWebUI knowledge bases / bots)
// ---------------------------------------------------------------------------

/**
 * Returns all knowledge targets ordered by name.
 *
 * @returns {Object[]} -> Target rows.
 */
function listTargets() {
  log('listTargets called');
  const db = getDatabase();
  return db.prepare('SELECT * FROM knowledge_targets ORDER BY name COLLATE NOCASE ASC').all();
}

/**
 * Returns a single knowledge target by id.
 *
 * @param {string} id -> Target id.
 * @returns {Object|null} -> The row or null.
 */
function getTarget(id) {
  log('getTarget called with: %o', { id });
  const db = getDatabase();
  return db.prepare('SELECT * FROM knowledge_targets WHERE id = ?').get(id) ?? null;
}

/**
 * Inserts a knowledge target.
 *
 * @param {Object} target -> Target fields (id, name, owuiUrl, owuiTokenEnc, knowledgeId, enabled).
 * @returns {void}
 */
function insertTarget({ id, name, owuiUrl = null, owuiTokenEnc = null, knowledgeId = null, enabled = 1 }) {
  log('insertTarget called with: %o', { id, name });
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`
    INSERT INTO knowledge_targets (id, name, owui_url, owui_token_enc, knowledge_id, enabled, created_at, updated_at)
    VALUES (@id, @name, @owuiUrl, @owuiTokenEnc, @knowledgeId, @enabled, @now, @now)
  `).run({ id, name, owuiUrl, owuiTokenEnc, knowledgeId, enabled: enabled ? 1 : 0, now });
}

/**
 * Updates a knowledge target.
 *
 * @param {string} id -> Target id.
 * @param {Object} fields -> { name, owuiUrl, owuiTokenEnc, knowledgeId, enabled }.
 * @returns {boolean} -> True if a row was updated.
 */
function updateTarget(id, { name, owuiUrl, owuiTokenEnc, knowledgeId, enabled }) {
  log('updateTarget called with: %o', { id });
  const db = getDatabase();
  const info = db.prepare(`
    UPDATE knowledge_targets
    SET name = @name, owui_url = @owuiUrl, owui_token_enc = @owuiTokenEnc,
        knowledge_id = @knowledgeId, enabled = @enabled, updated_at = @now
    WHERE id = @id
  `).run({ id, name, owuiUrl, owuiTokenEnc, knowledgeId, enabled: enabled ? 1 : 0, now: Date.now() });
  return info.changes > 0;
}

/**
 * Deletes a knowledge target by id.
 *
 * @param {string} id -> Target id.
 * @returns {boolean} -> True if a row was deleted.
 */
function deleteTarget(id) {
  log('deleteTarget called with: %o', { id });
  const db = getDatabase();
  return db.prepare('DELETE FROM knowledge_targets WHERE id = ?').run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------

/**
 * Returns all routing rules ordered by sort_order then name.
 *
 * @returns {Object[]} -> Rule rows.
 */
function listRules() {
  log('listRules called');
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM routing_rules ORDER BY sort_order ASC, name COLLATE NOCASE ASC')
    .all();
}

/**
 * Inserts a routing rule.
 *
 * @param {Object} rule -> Rule fields (id, name, enabled, sortOrder, conditionsJson, ignoreConditionsJson, targetIdsJson, mcpIdsJson).
 * @returns {void}
 */
function insertRule({ id, name, enabled = 1, sortOrder = 0, conditionsJson = '[]', ignoreConditionsJson = '[]', targetIdsJson = '[]', mcpIdsJson = '[]' }) {
  log('insertRule called with: %o', { id, name });
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`
    INSERT INTO routing_rules (id, name, enabled, sort_order, conditions_json, ignore_conditions_json, target_ids_json, mcp_ids_json, created_at, updated_at)
    VALUES (@id, @name, @enabled, @sortOrder, @conditionsJson, @ignoreConditionsJson, @targetIdsJson, @mcpIdsJson, @now, @now)
  `).run({ id, name, enabled: enabled ? 1 : 0, sortOrder, conditionsJson, ignoreConditionsJson, targetIdsJson, mcpIdsJson, now });
}

/**
 * Updates a routing rule.
 *
 * @param {string} id -> Rule id.
 * @param {Object} fields -> { name, enabled, sortOrder, conditionsJson, ignoreConditionsJson, targetIdsJson }.
 * @returns {boolean} -> True if a row was updated.
 */
function updateRule(id, { name, enabled, sortOrder, conditionsJson, ignoreConditionsJson = '[]', targetIdsJson, mcpIdsJson = '[]' }) {
  log('updateRule called with: %o', { id });
  const db = getDatabase();
  const info = db.prepare(`
    UPDATE routing_rules
    SET name = @name, enabled = @enabled, sort_order = @sortOrder,
        conditions_json = @conditionsJson, ignore_conditions_json = @ignoreConditionsJson,
        target_ids_json = @targetIdsJson,
        mcp_ids_json = @mcpIdsJson, updated_at = @now
    WHERE id = @id
  `).run({ id, name, enabled: enabled ? 1 : 0, sortOrder, conditionsJson, ignoreConditionsJson, targetIdsJson, mcpIdsJson, now: Date.now() });
  return info.changes > 0;
}

/**
 * Deletes a routing rule by id.
 *
 * @param {string} id -> Rule id.
 * @returns {boolean} -> True if a row was deleted.
 */
function deleteRule(id) {
  log('deleteRule called with: %o', { id });
  const db = getDatabase();
  return db.prepare('DELETE FROM routing_rules WHERE id = ?').run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Ticket uploads (per ticket x target)
// ---------------------------------------------------------------------------

/**
 * Inserts or updates the upload record for a ticket/target pair.
 *
 * @param {string} jiraId -> Issue key.
 * @param {string} targetId -> Knowledge target id.
 * @param {string|null} owuiUuid -> File UUID in OpenWebUI.
 * @returns {void}
 */
function upsertTicketUpload(jiraId, targetId, owuiUuid) {
  log('upsertTicketUpload called with: %o', { jiraId, targetId });
  const db = getDatabase();
  db.prepare(`
    INSERT INTO ticket_uploads (jira_id, target_id, owui_uuid, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(jira_id, target_id) DO UPDATE SET owui_uuid = excluded.owui_uuid, updated_at = excluded.updated_at
  `).run(jiraId, targetId, owuiUuid, Date.now());
}

/**
 * Lists upload records for a ticket.
 *
 * @param {string} jiraId -> Issue key.
 * @returns {Object[]} -> Upload rows.
 */
function listTicketUploads(jiraId) {
  log('listTicketUploads called with: %o', { jiraId });
  const db = getDatabase();
  return db.prepare('SELECT * FROM ticket_uploads WHERE jira_id = ?').all(jiraId);
}

/**
 * Returns a single upload record for a ticket/target pair.
 *
 * @param {string} jiraId -> Issue key.
 * @param {string} targetId -> Knowledge target id.
 * @returns {Object|null} -> The row or null.
 */
function getTicketUpload(jiraId, targetId) {
  log('getTicketUpload called with: %o', { jiraId, targetId });
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM ticket_uploads WHERE jira_id = ? AND target_id = ?')
    .get(jiraId, targetId) ?? null;
}

// ---------------------------------------------------------------------------
// Ticket lifecycle
// ---------------------------------------------------------------------------

/**
 * Sets the lifecycle state of a ticket ('active' | 'obsolete' | 'deleted').
 *
 * @param {string} jiraId -> Issue key.
 * @param {string} lifecycle -> One of TICKET_LIFECYCLE values.
 * @returns {void}
 */
function setTicketLifecycle(jiraId, lifecycle) {
  log('setTicketLifecycle called with: %o', { jiraId, lifecycle });
  const db = getDatabase();
  db.prepare('UPDATE tickets SET lifecycle = ?, updated_at = ? WHERE jira_id = ?').run(
    lifecycle,
    Date.now(),
    jiraId,
  );
}

// ---------------------------------------------------------------------------
// Ticket attachments
// ---------------------------------------------------------------------------

/**
 * Inserts or updates a single attachment record for a ticket.
 *
 * @param {Object} a -> Attachment fields.
 * @param {string} a.jiraId -> Owning issue key.
 * @param {string} a.jiraAttachmentId -> Jira attachment id.
 * @param {string} a.filename -> Original filename.
 * @param {string|null} a.mimeType -> MIME type.
 * @param {number} a.size -> Size in bytes.
 * @param {string|null} a.jiraCreated -> Jira-side created timestamp (ISO string).
 * @param {string|null} a.localPath -> Relative local path inside attachmentsDir.
 * @param {string} a.status -> 'stored' | 'skipped_too_large' | 'error'.
 * @returns {void}
 */
function upsertTicketAttachment({ jiraId, jiraAttachmentId, filename, mimeType = null, size = 0, jiraCreated = null, localPath = null, status = 'stored' }) {
  log('upsertTicketAttachment called with: %o', { jiraId, jiraAttachmentId, status });
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`
    INSERT INTO ticket_attachments (
      jira_id, jira_attachment_id, filename, mime_type, size, jira_created,
      local_path, status, created_at, updated_at
    )
    VALUES (@jiraId, @jiraAttachmentId, @filename, @mimeType, @size, @jiraCreated, @localPath, @status, @now, @now)
    ON CONFLICT(jira_id, jira_attachment_id) DO UPDATE SET
      filename     = excluded.filename,
      mime_type    = excluded.mime_type,
      size         = excluded.size,
      jira_created = excluded.jira_created,
      local_path   = excluded.local_path,
      status       = excluded.status,
      updated_at   = @now
  `).run({ jiraId, jiraAttachmentId, filename, mimeType, size, jiraCreated, localPath, status, now });
}

/**
 * Lists all attachment records for a ticket, oldest first.
 *
 * @param {string} jiraId -> Issue key.
 * @returns {Object[]} -> Attachment rows.
 */
function listTicketAttachments(jiraId) {
  log('listTicketAttachments called with: %o', { jiraId });
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM ticket_attachments WHERE jira_id = ? ORDER BY created_at ASC')
    .all(jiraId);
}

/**
 * Returns a single attachment record for a ticket/attachment pair.
 *
 * @param {string} jiraId -> Issue key.
 * @param {string} jiraAttachmentId -> Jira attachment id.
 * @returns {Object|null} -> The row, or null.
 */
function getTicketAttachment(jiraId, jiraAttachmentId) {
  log('getTicketAttachment called with: %o', { jiraId, jiraAttachmentId });
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM ticket_attachments WHERE jira_id = ? AND jira_attachment_id = ?')
    .get(jiraId, jiraAttachmentId) ?? null;
}

/**
 * Deletes a single attachment record.
 *
 * @param {string} jiraId -> Issue key.
 * @param {string} jiraAttachmentId -> Jira attachment id.
 * @returns {boolean} -> True if a row was deleted.
 */
function deleteTicketAttachment(jiraId, jiraAttachmentId) {
  log('deleteTicketAttachment called with: %o', { jiraId, jiraAttachmentId });
  const db = getDatabase();
  return db
    .prepare('DELETE FROM ticket_attachments WHERE jira_id = ? AND jira_attachment_id = ?')
    .run(jiraId, jiraAttachmentId).changes > 0;
}

// ---------------------------------------------------------------------------
// MCP connections + assignments
// ---------------------------------------------------------------------------

/**
 * Seeds the fixed MCP connections (idempotent: INSERT OR IGNORE keeps existing
 * admin-edited titles/descriptions intact).
 *
 * @param {Object[]} seeds -> Seed descriptors ({ id, title, description, isAll }).
 * @returns {void}
 */
function seedMcpConnections(seeds) {
  log('seedMcpConnections called with: %o', { count: seeds?.length });
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO mcp_connections (id, title, description, is_all, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      stmt.run(r.id, r.title, r.description || '', r.isAll ? 1 : 0, now, now);
    }
  });
  tx(seeds || []);
}

/**
 * Returns all MCP connections, the 'all' connection first, then by id.
 *
 * @returns {Object[]} -> Connection rows.
 */
function listMcpConnections() {
  log('listMcpConnections called');
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM mcp_connections ORDER BY is_all DESC, id ASC')
    .all();
}

/**
 * Returns a single MCP connection by id.
 *
 * @param {string} id -> Connection id (slug).
 * @returns {Object|null} -> The row, or null.
 */
function getMcpConnection(id) {
  log('getMcpConnection called with: %o', { id });
  const db = getDatabase();
  return db.prepare('SELECT * FROM mcp_connections WHERE id = ?').get(id) ?? null;
}

/**
 * Updates the title/description of an MCP connection. The id/slug is immutable.
 *
 * @param {string} id -> Connection id.
 * @param {Object} fields -> { title, description }.
 * @returns {boolean} -> True if a row was updated.
 */
function updateMcpConnection(id, { title, description }) {
  log('updateMcpConnection called with: %o', { id });
  const db = getDatabase();
  return db
    .prepare('UPDATE mcp_connections SET title = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(title, description || '', Date.now(), id).changes > 0;
}

/**
 * Updates the authentication settings of an MCP connection. The require_auth
 * flag is always written; the encrypted token is only replaced when
 * authTokenEnc is provided (pass `undefined` to keep the stored token, or an
 * explicit value/null to set/clear it).
 *
 * @param {string} id -> Connection id.
 * @param {Object} fields -> { requireAuth: boolean, authTokenEnc?: string|null }.
 * @returns {boolean} -> True if a row was updated.
 */
function updateMcpConnectionAuth(id, { requireAuth, authTokenEnc }) {
  log('updateMcpConnectionAuth called with: %o', { id });
  const db = getDatabase();
  if (authTokenEnc === undefined) {
    return db
      .prepare('UPDATE mcp_connections SET require_auth = ?, updated_at = ? WHERE id = ?')
      .run(requireAuth ? 1 : 0, Date.now(), id).changes > 0;
  }
  return db
    .prepare('UPDATE mcp_connections SET require_auth = ?, auth_token_enc = ?, updated_at = ? WHERE id = ?')
    .run(requireAuth ? 1 : 0, authTokenEnc, Date.now(), id).changes > 0;
}

/**
 * Updates the "allow feedback" flag of an MCP connection. When enabled, the
 * connection exposes the write-capable report_inaccuracy tool.
 *
 * @param {string} id -> Connection id.
 * @param {Object} fields -> { allowFeedback: boolean }.
 * @returns {boolean} -> True if a row was updated.
 */
function updateMcpConnectionFeedback(id, { allowFeedback }) {
  log('updateMcpConnectionFeedback called with: %o', { id });
  const db = getDatabase();
  return db
    .prepare('UPDATE mcp_connections SET allow_feedback = ?, updated_at = ? WHERE id = ?')
    .run(allowFeedback ? 1 : 0, Date.now(), id).changes > 0;
}

/**
 * Replaces the set of MCP connection assignments for a ticket atomically.
 *
 * @param {string} jiraId -> Issue key.
 * @param {string[]} connectionIds -> Connection ids to assign.
 * @returns {void}
 */
function replaceTicketMcpAssignments(jiraId, connectionIds) {
  log('replaceTicketMcpAssignments called with: %o', { jiraId, count: connectionIds?.length });
  const db = getDatabase();
  const now = Date.now();
  const del = db.prepare('DELETE FROM ticket_mcp_assignments WHERE jira_id = ?');
  const ins = db.prepare(
    'INSERT OR IGNORE INTO ticket_mcp_assignments (jira_id, connection_id, updated_at) VALUES (?, ?, ?)',
  );
  const tx = db.transaction((ids) => {
    del.run(jiraId);
    for (const id of ids) {
      ins.run(jiraId, id, now);
    }
  });
  tx(Array.isArray(connectionIds) ? connectionIds : []);
}

/**
 * Lists the connection ids assigned to a ticket.
 *
 * @param {string} jiraId -> Issue key.
 * @returns {string[]} -> Connection ids.
 */
function listTicketMcpAssignments(jiraId) {
  log('listTicketMcpAssignments called with: %o', { jiraId });
  const db = getDatabase();
  return db
    .prepare('SELECT connection_id FROM ticket_mcp_assignments WHERE jira_id = ?')
    .all(jiraId)
    .map((r) => r.connection_id);
}

// ---------------------------------------------------------------------------
// MCP knowledge scoping
//
// All MCP doc queries filter to active tickets that already produced markdown.
// The 'all' connection (is_all = 1) exposes every such ticket; any other
// connection joins ticket_mcp_assignments to scope to its assigned tickets.
// ---------------------------------------------------------------------------

/**
 * Builds the scoping WHERE clause + params for the MCP doc queries.
 *
 * @param {Object} connection -> Connection row ({ id, is_all }).
 * @returns {{join: string, where: string, params: Object}} -> SQL fragments.
 */
function mcpScope(connection) {
  if (connection && connection.is_all) {
    return {
      join: '',
      where: "t.lifecycle = 'active' AND t.markdown IS NOT NULL",
      params: {},
    };
  }
  return {
    join: 'JOIN ticket_mcp_assignments a ON a.jira_id = t.jira_id',
    where: "a.connection_id = @connId AND t.lifecycle = 'active' AND t.markdown IS NOT NULL",
    params: { connId: connection?.id },
  };
}

/**
 * Lists the knowledge docs in scope for a connection (metadata only).
 *
 * @param {Object} connection -> Connection row.
 * @returns {Object[]} -> Rows with jira_id, summary, markdown_size, updated_at.
 */
function listMcpDocs(connection) {
  log('listMcpDocs called with: %o', { connId: connection?.id });
  const db = getDatabase();
  const { join, where, params } = mcpScope(connection);
  const sql = `
    SELECT t.jira_id, t.summary, t.markdown_size, t.updated_at
    FROM tickets t
    ${join}
    WHERE ${where}
    ORDER BY t.updated_at DESC
  `;
  return db.prepare(sql).all(params);
}

/**
 * Returns a single knowledge doc (incl. markdown) for a connection, scoped.
 *
 * @param {Object} connection -> Connection row.
 * @param {string} jiraId -> Issue key.
 * @returns {Object|null} -> Row with jira_id, summary, markdown, updated_at, or null.
 */
function getMcpDoc(connection, jiraId) {
  log('getMcpDoc called with: %o', { connId: connection?.id, jiraId });
  const db = getDatabase();
  const { join, where, params } = mcpScope(connection);
  const sql = `
    SELECT t.jira_id, t.summary, t.markdown, t.markdown_size, t.updated_at
    FROM tickets t
    ${join}
    WHERE ${where} AND t.jira_id = @jiraId
  `;
  return db.prepare(sql).get({ ...params, jiraId }) ?? null;
}

/**
 * Full-text-ish search over markdown + summary for a connection's docs.
 *
 * @param {Object} connection -> Connection row.
 * @param {string} query -> Search term (case-insensitive LIKE).
 * @param {number} [limit=20] -> Maximum number of matches.
 * @returns {Object[]} -> Rows with jira_id, summary, markdown, updated_at.
 */
function searchMcpDocs(connection, query, limit = 20) {
  log('searchMcpDocs called with: %o', { connId: connection?.id, query });
  const db = getDatabase();
  const { join, where, params } = mcpScope(connection);
  const q = `%${String(query || '').toLowerCase()}%`;
  const sql = `
    SELECT t.jira_id, t.summary, t.markdown, t.markdown_size, t.updated_at
    FROM tickets t
    ${join}
    WHERE ${where} AND (LOWER(t.markdown) LIKE @q OR LOWER(t.summary) LIKE @q)
    ORDER BY t.updated_at DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all({ ...params, q, limit });
}

/**
 * Loads the embedded docs in scope for a connection so the caller can rank them
 * by vector similarity in JS. Only rows whose embedding was produced with the
 * given model tag are returned, so stale embeddings from a previous model are
 * transparently ignored after a model switch.
 *
 * @param {Object} connection -> Connection row.
 * @param {string} model -> Current model tag.
 * @returns {Object[]} -> Rows with jira_id, summary, markdown, markdown_size, updated_at, embedding (Buffer).
 */
function listEmbeddedDocs(connection, model) {
  log('listEmbeddedDocs called with: %o', { connId: connection?.id, model });
  const db = getDatabase();
  const { join, where, params } = mcpScope(connection);
  const sql = `
    SELECT t.jira_id, t.summary, t.markdown, t.markdown_size, t.updated_at, t.embedding
    FROM tickets t
    ${join}
    WHERE ${where} AND t.embedding IS NOT NULL AND t.embedding_model IS @model
  `;
  return db.prepare(sql).all({ ...params, model });
}

/**
 * Returns the doc count and total markdown bytes in scope for a connection.
 *
 * @param {Object} connection -> Connection row.
 * @returns {{count: number, bytes: number}} -> Aggregate stats.
 */
function getMcpConnectionStats(connection) {
  log('getMcpConnectionStats called with: %o', { connId: connection?.id });
  const db = getDatabase();
  const { join, where, params } = mcpScope(connection);
  const sql = `
    SELECT COUNT(*) AS count, COALESCE(SUM(t.markdown_size), 0) AS bytes
    FROM tickets t
    ${join}
    WHERE ${where}
  `;
  const row = db.prepare(sql).get(params);
  return { count: row.count, bytes: row.bytes };
}

// ---------------------------------------------------------------------------
// Upload + dummy cleanup (used by the soft-delete lifecycle service)
// ---------------------------------------------------------------------------

/**
 * Deletes all upload records for a ticket.
 *
 * @param {string} jiraId -> Issue key.
 * @returns {number} -> Number of deleted rows.
 */
function deleteTicketUploads(jiraId) {
  log('deleteTicketUploads called with: %o', { jiraId });
  const db = getDatabase();
  return db.prepare('DELETE FROM ticket_uploads WHERE jira_id = ?').run(jiraId).changes;
}

/**
 * Marks a dummy file as no longer part of the knowledge base. Mirrors the
 * real-mode knowledge/remove call.
 *
 * @param {string} uuid -> File UUID.
 * @returns {boolean} -> True if a row was updated.
 */
function unmarkDummyFileInKnowledge(uuid) {
  log('unmarkDummyFileInKnowledge called with: %o', { uuid });
  const db = getDatabase();
  return db
    .prepare('UPDATE openwebui_dummy_files SET in_knowledge = 0, updated_at = ? WHERE uuid = ?')
    .run(Date.now(), uuid).changes > 0;
}

/**
 * Deletes a dummy file record. The on-disk file is removed by the caller.
 *
 * @param {string} uuid -> File UUID.
 * @returns {boolean} -> True if a row was deleted.
 */
function deleteDummyFile(uuid) {
  log('deleteDummyFile called with: %o', { uuid });
  const db = getDatabase();
  return db.prepare('DELETE FROM openwebui_dummy_files WHERE uuid = ?').run(uuid).changes > 0;
}

// ---------------------------------------------------------------------------
// Danger Zone (global wipes)
// ---------------------------------------------------------------------------

/**
 * Counts all activity events.
 *
 * @returns {number} -> Total number of rows in the events table.
 */
function countEvents() {
  log('countEvents called');
  const db = getDatabase();
  return db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
}

/**
 * Deletes every activity event.
 *
 * @returns {number} -> Number of deleted rows.
 */
function deleteAllEvents() {
  log('deleteAllEvents called');
  const db = getDatabase();
  return db.prepare('DELETE FROM events').run().changes;
}

/**
 * Returns every ticket upload record across all tickets. Used by the global
 * wipe to collect the affected jira ids before knowledge is removed.
 *
 * @returns {Object[]} -> All ticket_uploads rows.
 */
function listAllTicketUploads() {
  log('listAllTicketUploads called');
  const db = getDatabase();
  return db.prepare('SELECT * FROM ticket_uploads').all();
}

/**
 * Deletes all ticket-related data in a single transaction. Rows are removed in
 * child-before-parent order so the operation does not depend on cascade
 * behavior, and the whole wipe is atomic.
 *
 * @returns {number} -> Number of deleted ticket rows.
 */
function deleteAllTicketData() {
  log('deleteAllTicketData called');
  const db = getDatabase();
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM ticket_mcp_assignments').run();
    db.prepare('DELETE FROM ticket_attachments').run();
    db.prepare('DELETE FROM ticket_uploads').run();
    db.prepare('DELETE FROM workflow_runs').run();
    db.prepare('DELETE FROM openwebui_dummy_files').run();
    return db.prepare('DELETE FROM tickets').run().changes;
  });
  return wipe();
}

/**
 * Internal step status export, re-exported for convenience.
 */
const STEP = STEP_STATUS;

module.exports = {
  STEP,
  upsertTicket,
  updateTicketMarkdown,
  updateTicketEmbedding,
  setTicketEmbeddingStatus,
  listTicketsForEmbedding,
  getEmbeddingStats,
  setTicketOpenWebUiUuid,
  setTicketOverallStatus,
  getTicket,
  countTickets,
  listTickets,
  countTicketsByStatus,
  resetWorkflowRun,
  setStepStatus,
  finishWorkflowRun,
  getWorkflowRun,
  insertEvent,
  listEvents,
  throughputByDay,
  funnelCounts,
  getDashboardStats,
  insertDummyFile,
  updateDummyFileContent,
  markDummyFileInKnowledge,
  getDummyFile,
  getSetting,
  setSetting,
  listTargets,
  getTarget,
  insertTarget,
  updateTarget,
  deleteTarget,
  listRules,
  insertRule,
  updateRule,
  deleteRule,
  upsertTicketUpload,
  listTicketUploads,
  getTicketUpload,
  setTicketLifecycle,
  upsertTicketAttachment,
  listTicketAttachments,
  getTicketAttachment,
  deleteTicketAttachment,
  seedMcpConnections,
  listMcpConnections,
  getMcpConnection,
  updateMcpConnection,
  updateMcpConnectionAuth,
  updateMcpConnectionFeedback,
  replaceTicketMcpAssignments,
  listTicketMcpAssignments,
  listMcpDocs,
  getMcpDoc,
  searchMcpDocs,
  listEmbeddedDocs,
  getMcpConnectionStats,
  deleteTicketUploads,
  unmarkDummyFileInKnowledge,
  deleteDummyFile,
  countEvents,
  deleteAllEvents,
  listAllTicketUploads,
  deleteAllTicketData,
};
