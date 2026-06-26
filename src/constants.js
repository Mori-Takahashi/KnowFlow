'use strict';

/**
 * Centralized constants for the KnowFlow application.
 *
 * Workflow steps, internal status codes, and Jira status mappings live here so
 * that no service file contains magic strings.
 */

/**
 * Ordered list of workflow step identifiers used in the pipeline.
 * Index matches the WebUI columns and DB columns step_1, step_2, step_3.
 */
const WORKFLOW_STEPS = Object.freeze([
  { id: 'jira_fetch', label: 'Aus Jira laden' },
  { id: 'markdown_save', label: 'Markdown speichern' },
  { id: 'openwebui_upload', label: 'OpenWebUI Upload' },
]);

/**
 * Per-step status values stored in the DB.
 *
 * idle -> step has not yet started
 * work -> step is currently running
 * done -> step finished successfully
 * err  -> step failed (see workflow_runs.error)
 */
const STEP_STATUS = Object.freeze({
  IDLE: 'idle',
  WORK: 'work',
  DONE: 'done',
  ERR: 'err',
});

/**
 * Overall ticket status values shown in the UI.
 *
 * done   -> all three steps finished successfully
 * work   -> at least one step is running, no error
 * err    -> at least one step ended with err
 * rework -> Jira moved the ticket to a rework status, file will be overwritten on next Done
 * idle   -> ticket is known but pipeline has not started yet
 */
const TICKET_STATUS = Object.freeze({
  DONE: 'done',
  WORK: 'work',
  ERR: 'err',
  REWORK: 'rework',
  IDLE: 'idle',
});

/**
 * Activity event kinds shown in the UI feed.
 */
const ACTIVITY_KIND = Object.freeze({
  OK: 'ok',
  INFO: 'info',
  WARN: 'warn',
  ERR: 'err',
  REWORK: 'rework',
});

/**
 * Socket.IO event names used to push live updates to the WebUI.
 */
const SOCKET_EVENTS = Object.freeze({
  WORKFLOW_UPDATE: 'workflow:update',
  ACTIVITY_NEW: 'activity:new',
  HEALTH_UPDATE: 'health:update',
  TICKET_STATUS: 'ticket:status',
  VERSION_UPDATE: 'version:update',
  RAG_PROGRESS: 'rag:progress',
});

/**
 * Severity of a version notice pushed to the dashboard.
 *
 * release -> a new release (major/minor) is shown as a dismissible banner
 * patch   -> a small change (patch) is shown as a transient toast
 */
const VERSION_NOTICE_LEVEL = Object.freeze({
  RELEASE: 'release',
  PATCH: 'patch',
});

/**
 * Default upstream repository (owner/repo) polled for releases. Forks override
 * this in the admin dashboard so they track their own releases instead.
 */
const DEFAULT_UPDATE_REPO = 'Mori-Takahashi/KnowFlow';

/**
 * Base URL of the GitHub REST API used for the releases poll.
 */
const GITHUB_API_BASE_URL = 'https://api.github.com';

/**
 * Interval of the periodic background update check, in milliseconds. 6 hours by
 * default so a long-running instance still notices new releases without a
 * webhook configured.
 */
const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Cache TTL for a remote release fetch, in milliseconds. Non-forced checks
 * within this window are served from the in-memory cache to spare the GitHub
 * rate limit. 30 minutes by default.
 */
const VERSION_CHECK_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Maximum number of stored manual announcements. Older entries are dropped when
 * the cap is exceeded.
 */
const VERSION_ANNOUNCEMENTS_MAX = 20;

/**
 * Days before an API token's configured expiry date at which the dashboard
 * starts warning the operator to renew or extend the token.
 */
const TOKEN_EXPIRY_REMINDER_DAYS = 10;

/**
 * Open WebUI integration modes.
 */
const OPENWEBUI_MODE = Object.freeze({
  DUMMY: 'dummy',
  REAL: 'real',
});

/**
 * Logical field keys used across the app. They decouple the admin-configurable
 * mapping from the concrete Jira field id (e.g. 'customfield_10050'). The admin
 * dashboard assigns a real Jira field to each of these via auto-discovery.
 */
const LOGICAL_FIELDS = Object.freeze({
  DESCRIPTION: 'description',
  SOLUTION: 'solution',
  TARGET_BOT: 'targetBot',
  CATEGORY: 'category',
  LABEL: 'label',
  HINT: 'hint',
});

/**
 * Default logical-field -> Jira-field mapping used when seeding from ENV.
 * Only the description maps to the Jira system field out of the box; the rest
 * are left empty until the admin maps them in the dashboard.
 */
const DEFAULT_FIELD_MAPPINGS = Object.freeze({
  [LOGICAL_FIELDS.DESCRIPTION]: 'description',
  [LOGICAL_FIELDS.SOLUTION]: '',
  [LOGICAL_FIELDS.TARGET_BOT]: '',
  [LOGICAL_FIELDS.CATEGORY]: '',
  [LOGICAL_FIELDS.LABEL]: 'labels',
  [LOGICAL_FIELDS.HINT]: '',
});

/**
 * Operators available in the routing rule builder. A rule condition is
 * { field: <LOGICAL_FIELDS value>, operator: <one of these>, value: <string> }.
 *
 * equals   -> field value equals the configured value (case-insensitive)
 * contains -> field value (or any entry of a multi-value field) contains value
 * in       -> the configured value (a multi-value field) includes the field value
 * exists   -> the field has any non-empty value (value is ignored)
 */
const ROUTING_OPERATORS = Object.freeze(['equals', 'contains', 'in', 'exists']);

/**
 * Embedding (RAG) modes for the optional semantic search layer.
 *
 * off    -> no embeddings; search_knowledge stays keyword-only (LIKE)
 * ollama -> embeddings via a local Ollama instance (POST /api/embeddings)
 * openai -> embeddings via the OpenAI embeddings API
 */
const RAG_MODE = Object.freeze({
  OFF: 'off',
  OLLAMA: 'ollama',
  OPENAI: 'openai',
  LOCAL: 'local',
});

/**
 * Default model for the in-process local embedding provider (Transformers.js).
 * A small, multilingual sentence-transformers model that covers German and
 * English ticket text and runs comfortably on CPU. Used when the admin selects
 * the `local` mode without naming an explicit model.
 */
const DEFAULT_LOCAL_EMBED_MODEL = 'Xenova/multilingual-e5-small';

/**
 * Per-ticket embedding status stored in tickets.embedding_status.
 *
 * none   -> never embedded (or RAG was off when the ticket was processed)
 * done   -> a current embedding is stored
 * failed -> the last embedding attempt errored (search falls back to keyword)
 */
const EMBEDDING_STATUS = Object.freeze({
  NONE: 'none',
  DONE: 'done',
  FAILED: 'failed',
});

/**
 * Default RAG configuration. The Ollama URL points at the conventional local
 * port; the model is empty until the admin picks one in the dashboard.
 */
const DEFAULT_RAG_CONFIG = Object.freeze({
  mode: RAG_MODE.OFF,
  ollamaUrl: 'http://localhost:11434',
  model: '',
  dim: 0,
});

/**
 * Maximum number of characters of ticket markdown fed into the embedding model.
 * Generous enough to cover description + solution of a typical ticket while
 * staying within the context window of small embedding models.
 */
const EMBEDDING_MAX_CHARS = 8000;

/**
 * Default markdown template options. Sections can be toggled and re-titled from
 * the admin dashboard. Comments are never included (product decision).
 */
const DEFAULT_MARKDOWN_OPTIONS = Object.freeze({
  descriptionHeading: 'Beschreibung',
  solutionHeading: 'Lösung',
  hintHeading: 'Hinweis',
  metadataHeading: 'Metadaten',
  attachmentsHeading: 'Anhänge',
  includeHint: true,
  includeMetadata: true,
  includeAttachments: true,
});

/**
 * Lifecycle states for a ticket. Independent of the workflow status: a ticket
 * can be 'done' (overall_status) but later marked 'obsolete' or 'deleted' by an
 * admin, which removes its knowledge from OpenWebUI and stops webhooks from
 * re-running the pipeline.
 *
 * active   -> normal, the pipeline and webhooks operate as usual
 * obsolete -> knowledge removed from OpenWebUI, kept in the DB, can be restored
 * deleted  -> knowledge removed and files deleted, can be restored (re-run)
 */
const TICKET_LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  OBSOLETE: 'obsolete',
  DELETED: 'deleted',
});

/**
 * Default maximum size (in bytes) for a single Jira attachment that the bot
 * downloads and stores locally. Larger attachments are recorded as
 * 'skipped_too_large' and not downloaded. 20 MiB by default.
 */
const ATTACHMENT_MAX_BYTES_DEFAULT = 20 * 1024 * 1024;

/**
 * Fixed seed list for the six MCP knowledge connections. The ids/slugs are
 * immutable (used in the MCP endpoint URLs); titles and descriptions are
 * admin-editable. The first entry ('all') exposes the knowledge of every active
 * ticket; the remaining five are assignable per ticket via routing rules.
 */
const MCP_CONNECTION_SEEDS = Object.freeze([
  {
    id: 'all',
    title: 'All-in-One',
    description: 'Gesamtes Wissen aller Tickets',
    isAll: true,
  },
  { id: 'mcp-1', title: 'Verbindung 1', description: '', isAll: false },
  { id: 'mcp-2', title: 'Verbindung 2', description: '', isAll: false },
  { id: 'mcp-3', title: 'Verbindung 3', description: '', isAll: false },
  { id: 'mcp-4', title: 'Verbindung 4', description: '', isAll: false },
  { id: 'mcp-5', title: 'Verbindung 5', description: '', isAll: false },
]);

/**
 * Session roles. An admin has full control; a user has a restricted view whose
 * exact capabilities are governed by the access configuration below.
 */
const SESSION_ROLES = Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
});

/**
 * Default access configuration governing the optional user role and the global
 * dashboard lock.
 *
 * dashboardLocked  -> when true, the whole dashboard (read APIs + live socket)
 *                     is only visible after a login (admin or user).
 * userPermissions  -> what an authenticated *user* (not admin) may do:
 *   viewSettings    -> open the settings/admin tab and read the configuration
 *   editSettings    -> additionally change the configuration
 *   manageLifecycle -> change a ticket's lifecycle (obsolete/delete/reactivate)
 */
const DEFAULT_ACCESS_CONFIG = Object.freeze({
  dashboardLocked: false,
  userPermissions: Object.freeze({
    viewSettings: false,
    editSettings: false,
    manageLifecycle: false,
  }),
});

/**
 * Default pagination size for ticket list.
 */
const TICKETS_PER_PAGE = 10;

/**
 * HTTP timeout for outgoing requests (Jira, Open WebUI) in milliseconds.
 */
const HTTP_TIMEOUT_MS = 15000;

/**
 * TTL for the cached /api/health response in milliseconds.
 * The endpoint hits Jira and Open WebUI on every miss, so a short TTL
 * multiplies request volume against external rate limits. 30 minutes is the
 * product decision: latency tile in the dashboard should refresh slowly.
 */
const HEALTH_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Maximum length of an error message included in a Jira comment.
 * Longer messages are truncated with an ellipsis. Avoids dumping stacktraces.
 */
const COMMENT_ERROR_MAX_LENGTH = 200;

/**
 * Static texts used in the three Jira comments posted by the workflow.
 *
 * Stored here so no German user-facing string lives inside service logic.
 * The comment body in jiraService prepends an @mention and appends a link,
 * so these templates contain only the middle prose.
 */
const COMMENT_TEMPLATES = Object.freeze({
  RECEIVED: 'dein Ticket wurde vom KnowFlow empfangen und wird gerade verarbeitet. Den Live-Status kannst du hier einsehen:',
  RECEIVED_NO_MENTION: 'Dein Ticket wurde vom KnowFlow empfangen und wird gerade verarbeitet. Den Live-Status kannst du hier einsehen:',
  SUCCESS: 'das Wissen aus deinem Ticket wurde erfolgreich an die Wissensbasis übermittelt. Details:',
  SUCCESS_NO_MENTION: 'Das Wissen aus deinem Ticket wurde erfolgreich an die Wissensbasis übermittelt. Details:',
  // The failure template is built dynamically because it interpolates the step name + error.
  FAILURE_LINK_LABEL: 'Details und Retry',
  RECEIVED_LINK_LABEL: 'KnowFlow Dashboard öffnen',
  SUCCESS_LINK_LABEL: 'KnowFlow Dashboard öffnen',
  // Feedback comment posted via the MCP report_inaccuracy tool.
  INACCURACY_INTRO: 'über die Wissensbasis (KnowFlow/MCP) wurde eine mögliche Ungenauigkeit in diesem Wissensartikel gemeldet:',
  INACCURACY_INTRO_NO_MENTION: 'Über die Wissensbasis (KnowFlow/MCP) wurde eine mögliche Ungenauigkeit in diesem Wissensartikel gemeldet:',
  INACCURACY_WHAT_LABEL: 'Was nicht stimmt:',
  INACCURACY_CORRECTION_LABEL: 'Vorgeschlagene Korrektur:',
  INACCURACY_LINK_LABEL: 'Ticket im KnowFlow Dashboard öffnen',
});

module.exports = {
  WORKFLOW_STEPS,
  STEP_STATUS,
  TICKET_STATUS,
  ACTIVITY_KIND,
  SOCKET_EVENTS,
  VERSION_NOTICE_LEVEL,
  DEFAULT_UPDATE_REPO,
  GITHUB_API_BASE_URL,
  VERSION_CHECK_INTERVAL_MS,
  VERSION_CHECK_CACHE_TTL_MS,
  VERSION_ANNOUNCEMENTS_MAX,
  TOKEN_EXPIRY_REMINDER_DAYS,
  OPENWEBUI_MODE,
  RAG_MODE,
  DEFAULT_LOCAL_EMBED_MODEL,
  EMBEDDING_STATUS,
  DEFAULT_RAG_CONFIG,
  EMBEDDING_MAX_CHARS,
  LOGICAL_FIELDS,
  DEFAULT_FIELD_MAPPINGS,
  ROUTING_OPERATORS,
  DEFAULT_MARKDOWN_OPTIONS,
  TICKET_LIFECYCLE,
  ATTACHMENT_MAX_BYTES_DEFAULT,
  MCP_CONNECTION_SEEDS,
  SESSION_ROLES,
  DEFAULT_ACCESS_CONFIG,
  TICKETS_PER_PAGE,
  HTTP_TIMEOUT_MS,
  HEALTH_CACHE_TTL_MS,
  COMMENT_ERROR_MAX_LENGTH,
  COMMENT_TEMPLATES,
};
