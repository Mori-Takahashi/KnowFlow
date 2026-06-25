'use strict';

const debug = require('debug');

const log = debug('knowflow:db:schema');

/**
 * SQL DDL statements that define the KnowFlow schema.
 *
 * Tables:
 *   tickets             -> one row per known Jira issue
 *   workflow_runs       -> per-step status for the latest pipeline run
 *   events              -> activity feed entries
 *   openwebui_dummy_files -> local mock storage for the Open WebUI dummy mode
 *   settings            -> key/value store (JSON values) for runtime config
 *   knowledge_targets   -> one row per OpenWebUI knowledge base / bot
 *   routing_rules       -> admin-defined rules mapping issue fields to targets
 *   ticket_uploads      -> per ticket x target tracking of uploaded files
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tickets (
    jira_id          TEXT PRIMARY KEY,
    project_key      TEXT NOT NULL,
    summary          TEXT NOT NULL,
    priority         TEXT,
    assignee         TEXT,
    reporter         TEXT,
    reporter_account_id TEXT,
    jira_status      TEXT,
    overall_status   TEXT NOT NULL DEFAULT 'idle',
    openwebui_uuid   TEXT,
    markdown         TEXT,
    markdown_size    INTEGER DEFAULT 0,
    first_seen_at    INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_status  ON tickets(overall_status);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    jira_id          TEXT PRIMARY KEY,
    step_1_status    TEXT NOT NULL DEFAULT 'idle',
    step_1_sub       TEXT,
    step_1_at        INTEGER,
    step_2_status    TEXT NOT NULL DEFAULT 'idle',
    step_2_sub       TEXT,
    step_2_at        INTEGER,
    step_3_status    TEXT NOT NULL DEFAULT 'idle',
    step_3_sub       TEXT,
    step_3_at        INTEGER,
    error            TEXT,
    started_at       INTEGER,
    finished_at      INTEGER,
    FOREIGN KEY (jira_id) REFERENCES tickets(jira_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    jira_id     TEXT,
    title       TEXT NOT NULL,
    detail      TEXT,
    source      TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);

  CREATE TABLE IF NOT EXISTS openwebui_dummy_files (
    uuid        TEXT PRIMARY KEY,
    jira_id     TEXT NOT NULL,
    content     TEXT NOT NULL,
    in_knowledge INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_targets (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    owui_url        TEXT,
    owui_token_enc  TEXT,
    knowledge_id    TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routing_rules (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    conditions_json TEXT NOT NULL DEFAULT '[]',
    ignore_conditions_json TEXT NOT NULL DEFAULT '[]',
    target_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ticket_uploads (
    jira_id     TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    owui_uuid   TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (jira_id, target_id),
    FOREIGN KEY (jira_id) REFERENCES tickets(jira_id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES knowledge_targets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_uploads_jira ON ticket_uploads(jira_id);

  CREATE TABLE IF NOT EXISTS ticket_attachments (
    jira_id            TEXT NOT NULL,
    jira_attachment_id TEXT NOT NULL,
    filename           TEXT NOT NULL,
    mime_type          TEXT,
    size               INTEGER NOT NULL DEFAULT 0,
    jira_created       TEXT,
    local_path         TEXT,
    status             TEXT NOT NULL DEFAULT 'stored',
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (jira_id, jira_attachment_id),
    FOREIGN KEY (jira_id) REFERENCES tickets(jira_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_jira ON ticket_attachments(jira_id);

  CREATE TABLE IF NOT EXISTS mcp_connections (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    is_all         INTEGER NOT NULL DEFAULT 0,
    require_auth   INTEGER NOT NULL DEFAULT 0,
    auth_token_enc TEXT,
    allow_feedback INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ticket_mcp_assignments (
    jira_id       TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (jira_id, connection_id),
    FOREIGN KEY (jira_id) REFERENCES tickets(jira_id) ON DELETE CASCADE,
    FOREIGN KEY (connection_id) REFERENCES mcp_connections(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_assign_conn ON ticket_mcp_assignments(connection_id);
`;

/**
 * Returns true when a table already has a column with the given name. Used to
 * make ALTER TABLE migrations idempotent (SQLite has no IF NOT EXISTS for
 * ADD COLUMN).
 *
 * @param {import('better-sqlite3').Database} db -> The open SQLite connection.
 * @param {string} table -> Table name.
 * @param {string} column -> Column name.
 * @returns {boolean} -> True if the column exists.
 */
function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

/**
 * Applies the schema DDL to the given database connection and runs additive
 * column migrations for tables that predate the lifecycle/MCP features.
 * Safe to call repeatedly; all statements use IF NOT EXISTS or a column check.
 *
 * @param {import('better-sqlite3').Database} db -> The open SQLite connection.
 * @returns {void}
 */
function applySchema(db) {
  log('applySchema called');
  db.exec(SCHEMA_SQL);

  // Additive migrations for existing databases.
  if (!columnExists(db, 'tickets', 'lifecycle')) {
    log('migrating: adding tickets.lifecycle');
    db.exec("ALTER TABLE tickets ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'");
  }
  if (!columnExists(db, 'routing_rules', 'mcp_ids_json')) {
    log('migrating: adding routing_rules.mcp_ids_json');
    db.exec("ALTER TABLE routing_rules ADD COLUMN mcp_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columnExists(db, 'routing_rules', 'ignore_conditions_json')) {
    log('migrating: adding routing_rules.ignore_conditions_json');
    db.exec("ALTER TABLE routing_rules ADD COLUMN ignore_conditions_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columnExists(db, 'mcp_connections', 'require_auth')) {
    log('migrating: adding mcp_connections.require_auth');
    db.exec('ALTER TABLE mcp_connections ADD COLUMN require_auth INTEGER NOT NULL DEFAULT 0');
  }
  if (!columnExists(db, 'mcp_connections', 'auth_token_enc')) {
    log('migrating: adding mcp_connections.auth_token_enc');
    db.exec('ALTER TABLE mcp_connections ADD COLUMN auth_token_enc TEXT');
  }
  if (!columnExists(db, 'mcp_connections', 'allow_feedback')) {
    log('migrating: adding mcp_connections.allow_feedback');
    db.exec('ALTER TABLE mcp_connections ADD COLUMN allow_feedback INTEGER NOT NULL DEFAULT 0');
  }

  // RAG / semantic search: a Float32 embedding stored as a BLOB next to the
  // markdown, plus the model tag and dimension it was produced with. The model
  // tag lets the search filter out embeddings from a different model after a
  // model switch, and lets the reindex job find tickets that need (re-)embedding.
  if (!columnExists(db, 'tickets', 'embedding')) {
    log('migrating: adding tickets.embedding columns');
    db.exec('ALTER TABLE tickets ADD COLUMN embedding BLOB');
    db.exec('ALTER TABLE tickets ADD COLUMN embedding_model TEXT');
    db.exec('ALTER TABLE tickets ADD COLUMN embedding_dim INTEGER');
    db.exec("ALTER TABLE tickets ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'none'");
  }
}

module.exports = { applySchema };
