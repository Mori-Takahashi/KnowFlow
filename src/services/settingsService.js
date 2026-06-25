'use strict';

const crypto = require('crypto');
const debug = require('debug');

const queries = require('../db/queries');
const { encrypt, decrypt } = require('../utils/crypto');
const {
  OPENWEBUI_MODE,
  RAG_MODE,
  DEFAULT_RAG_CONFIG,
  DEFAULT_FIELD_MAPPINGS,
  DEFAULT_MARKDOWN_OPTIONS,
  DEFAULT_UPDATE_REPO,
  DEFAULT_ACCESS_CONFIG,
  VERSION_ANNOUNCEMENTS_MAX,
  TOKEN_EXPIRY_REMINDER_DAYS,
} = require('../constants');

const log = debug('knowflow:settingsService');

// Settings keys (stored as JSON strings in the `settings` table).
const KEY = Object.freeze({
  JIRA: 'jira',
  FIELD_MAPPINGS: 'fieldMappings',
  MARKDOWN_OPTIONS: 'markdownOptions',
  OPENWEBUI_MODE: 'openwebuiMode',
  RAG: 'rag',
  FALLBACK_TARGETS: 'fallbackTargetIds',
  WEBHOOK_INGEST: 'webhookIngestEnabled',
  AUTH: 'auth',
  USER_AUTH: 'userAuth',
  ACCESS: 'access',
  SEEDED: 'seeded',
  SETUP_COMPLETED: 'setupCompleted',
  UPDATE_CHECK: 'updateCheck',
  VERSION_STATE: 'versionState',
  VERSION_ANNOUNCEMENTS: 'versionAnnouncements',
});

// Repository identifier pattern: owner/repo, both segments word chars, dots and
// dashes only. Used to validate the configurable update-check target.
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

// Monotonic version bumped on every write so dependent services (e.g. the Jira
// client) can detect configuration changes and rebuild lazily.
let version = 0;

// Small in-memory cache for parsed JSON settings, invalidated on write.
const cache = new Map();

/**
 * Parses a comma-separated string into trimmed, non-empty entries.
 *
 * @param {string|undefined} raw -> Raw value.
 * @returns {string[]} -> Parsed list.
 */
function parseList(raw) {
  if (!raw) return [];
  return raw.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
}

/**
 * Normalizes a Jira base URL so common copy/paste mistakes still yield a usable
 * value. Without this, a scheme-less host like "firma.atlassian.net" is stored
 * verbatim and every axios call dies with a cryptic "Invalid URL", which is
 * exactly what makes the setup wizard appear to "do nothing" while an
 * ENV-configured (fully-qualified) URL works.
 *
 * Steps: trim surrounding whitespace, prepend "https://" when no http(s) scheme
 * is present, and strip trailing slashes so REST paths concatenate cleanly. An
 * empty input stays empty (Jira simply not configured).
 *
 * @param {string|null|undefined} raw -> Raw base URL from the UI/ENV.
 * @returns {string} -> Normalized base URL, or '' when input is empty.
 */
function normalizeBaseUrl(raw) {
  let url = String(raw == null ? '' : raw).trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

/**
 * Reads and JSON-parses a settings value, with a fallback default. Cached.
 *
 * @param {string} key -> Settings key.
 * @param {*} fallback -> Value returned when the key is absent.
 * @returns {*} -> Parsed value or fallback.
 */
function readJson(key, fallback) {
  if (cache.has(key)) return cache.get(key);
  const raw = queries.getSetting(key);
  let value = fallback;
  if (raw != null) {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      console.error(`[settingsService] Konnte Setting "${key}" nicht parsen:`, err.message);
      value = fallback;
    }
  }
  cache.set(key, value);
  return value;
}

/**
 * Serializes and persists a settings value, invalidates the cache and bumps the
 * version counter.
 *
 * @param {string} key -> Settings key.
 * @param {*} value -> JSON-serializable value.
 * @returns {void}
 */
function writeJson(key, value) {
  queries.setSetting(key, JSON.stringify(value));
  cache.delete(key);
  version += 1;
}

/**
 * Returns the current settings version (incremented on every write).
 *
 * @returns {number} -> Version counter.
 */
function getVersion() {
  return version;
}

// ---------------------------------------------------------------------------
// Jira configuration (secrets stored encrypted inside the JSON blob)
// ---------------------------------------------------------------------------

/**
 * Returns the Jira configuration with secrets decrypted, ready for the service
 * layer. Never send this to the browser unmasked.
 *
 * @returns {Object} -> { baseUrl, email, apiToken, projectKeys, doneStatuses, reworkStatuses, webhookSecret }
 */
function getJiraConfig() {
  const raw = readJson(KEY.JIRA, {});
  return {
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    email: raw.email || '',
    apiToken: raw.apiToken ? decrypt(raw.apiToken) : '',
    projectKeys: Array.isArray(raw.projectKeys) ? raw.projectKeys : [],
    doneStatuses: Array.isArray(raw.doneStatuses) && raw.doneStatuses.length ? raw.doneStatuses : ['Done'],
    reworkStatuses: Array.isArray(raw.reworkStatuses) ? raw.reworkStatuses : [],
    webhookSecret: raw.webhookSecret ? decrypt(raw.webhookSecret) : '',
    apiTokenExpiresAt: typeof raw.apiTokenExpiresAt === 'string' ? raw.apiTokenExpiresAt : '',
  };
}

/**
 * Persists Jira configuration. Secret fields (apiToken, webhookSecret) are only
 * overwritten when a non-empty value is supplied, so the UI can submit masked
 * placeholders without wiping existing secrets.
 *
 * @param {Object} input -> Partial Jira config from the admin UI.
 * @returns {void}
 */
function setJiraConfig(input) {
  log('setJiraConfig called');
  const current = readJson(KEY.JIRA, {});
  const next = {
    baseUrl: input.baseUrl != null ? normalizeBaseUrl(input.baseUrl) : current.baseUrl || '',
    email: input.email != null ? input.email : current.email || '',
    apiToken: current.apiToken || '',
    projectKeys: Array.isArray(input.projectKeys) ? input.projectKeys : current.projectKeys || [],
    doneStatuses: Array.isArray(input.doneStatuses) ? input.doneStatuses : current.doneStatuses || ['Done'],
    reworkStatuses: Array.isArray(input.reworkStatuses) ? input.reworkStatuses : current.reworkStatuses || [],
    webhookSecret: current.webhookSecret || '',
    apiTokenExpiresAt: current.apiTokenExpiresAt || '',
  };
  if (input.apiToken) next.apiToken = encrypt(input.apiToken);
  if (input.webhookSecret) next.webhookSecret = encrypt(input.webhookSecret);
  // Expiry date is not a secret: an explicit (possibly empty) value always wins,
  // so the operator can clear the reminder by emptying the field.
  if (input.apiTokenExpiresAt != null) next.apiTokenExpiresAt = String(input.apiTokenExpiresAt).trim();
  writeJson(KEY.JIRA, next);
}

// ---------------------------------------------------------------------------
// Update check configuration (GitHub releases polling + optional webhook)
// ---------------------------------------------------------------------------

/**
 * Returns the update-check configuration with the secrets decrypted.
 * The repo defaults to DEFAULT_UPDATE_REPO so a fresh install tracks upstream.
 *
 * @returns {Object} -> { enabled, repo, githubWebhookSecret, githubToken }.
 */
function getUpdateCheckConfig() {
  const raw = readJson(KEY.UPDATE_CHECK, {});
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
  return {
    enabled: raw.enabled !== false,
    repo: repo || DEFAULT_UPDATE_REPO,
    githubWebhookSecret: raw.githubWebhookSecret ? decrypt(raw.githubWebhookSecret) : '',
    githubToken: raw.githubToken ? decrypt(raw.githubToken) : '',
    githubTokenExpiresAt: typeof raw.githubTokenExpiresAt === 'string' ? raw.githubTokenExpiresAt : '',
  };
}

/**
 * Persists the update-check configuration. Secret fields (webhook secret and
 * GitHub token) are only overwritten when a non-empty value is supplied
 * (masked placeholders keep the existing secret); `githubToken: null` clears
 * the stored token. The repo must be empty or match the owner/repo pattern; an
 * empty value falls back to DEFAULT_UPDATE_REPO.
 *
 * @param {Object} input -> Partial config from the admin UI.
 * @returns {void}
 * @throws {Error} -> If the repo value is set but malformed.
 */
function setUpdateCheckConfig(input) {
  log('setUpdateCheckConfig called');
  const current = readJson(KEY.UPDATE_CHECK, {});
  const repoRaw = input.repo != null ? String(input.repo).trim() : (current.repo || '');
  if (repoRaw && !REPO_PATTERN.test(repoRaw)) {
    throw new Error('Repo muss dem Muster "owner/repo" entsprechen.');
  }
  const next = {
    enabled: input.enabled != null ? Boolean(input.enabled) : current.enabled !== false,
    repo: repoRaw || DEFAULT_UPDATE_REPO,
    githubWebhookSecret: current.githubWebhookSecret || '',
    githubToken: current.githubToken || '',
    githubTokenExpiresAt: current.githubTokenExpiresAt || '',
  };
  if (input.githubWebhookSecret) {
    next.githubWebhookSecret = encrypt(input.githubWebhookSecret);
  }
  if (input.githubToken) {
    next.githubToken = encrypt(input.githubToken);
  } else if (input.githubToken === null) {
    next.githubToken = '';
  }
  // Expiry date is not a secret: an explicit (possibly empty) value always wins.
  if (input.githubTokenExpiresAt != null) {
    next.githubTokenExpiresAt = String(input.githubTokenExpiresAt).trim();
  }
  writeJson(KEY.UPDATE_CHECK, next);
}

/**
 * Computes reminders for API tokens whose configured expiry date is within the
 * warning window (TOKEN_EXPIRY_REMINDER_DAYS) or already in the past. Only
 * tokens that are actually configured *and* have an expiry date set are
 * considered. Used by the dashboard to prompt the operator to renew/extend a
 * token before it lapses.
 *
 * @returns {Array<Object>} -> Reminders: { key, label, expiresAt, daysLeft, expired }.
 */
function getTokenExpiryReminders() {
  const reminders = [];
  const today = new Date();
  const todayMidnight = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const DAY_MS = 86400000;

  const consider = (key, label, token, expiresAt) => {
    if (!token || !expiresAt) return;
    const ts = Date.parse(`${expiresAt}T00:00:00Z`);
    if (Number.isNaN(ts)) return;
    const daysLeft = Math.ceil((ts - todayMidnight) / DAY_MS);
    if (daysLeft <= TOKEN_EXPIRY_REMINDER_DAYS) {
      reminders.push({ key, label, expiresAt, daysLeft, expired: daysLeft < 0 });
    }
  };

  const jira = getJiraConfig();
  consider('jira', 'Jira-API-Token', jira.apiToken, jira.apiTokenExpiresAt);

  const update = getUpdateCheckConfig();
  consider('github', 'GitHub-Token', update.githubToken, update.githubTokenExpiresAt);

  return reminders;
}

/**
 * Returns the persisted version-notice state.
 *
 * @returns {Object} -> { lastNotifiedVersion }.
 */
function getVersionState() {
  const raw = readJson(KEY.VERSION_STATE, {});
  return {
    lastNotifiedVersion: typeof raw.lastNotifiedVersion === 'string' ? raw.lastNotifiedVersion : null,
  };
}

/**
 * Persists the version-notice state (used to avoid re-notifying the same
 * release on every poll).
 *
 * @param {Object} state -> { lastNotifiedVersion }.
 * @returns {void}
 */
function setVersionState(state) {
  log('setVersionState called');
  writeJson(KEY.VERSION_STATE, {
    lastNotifiedVersion: state && typeof state.lastNotifiedVersion === 'string' ? state.lastNotifiedVersion : null,
  });
}

/**
 * Returns the stored manual announcements, newest first.
 *
 * @returns {Object[]} -> Announcement records.
 */
function listVersionAnnouncements() {
  const list = readJson(KEY.VERSION_ANNOUNCEMENTS, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Prepends a manual announcement and caps the list at VERSION_ANNOUNCEMENTS_MAX.
 *
 * @param {Object} announcement -> Announcement record.
 * @returns {Object} -> The stored announcement.
 */
function addVersionAnnouncement(announcement) {
  log('addVersionAnnouncement called');
  const list = listVersionAnnouncements();
  list.unshift(announcement);
  writeJson(KEY.VERSION_ANNOUNCEMENTS, list.slice(0, VERSION_ANNOUNCEMENTS_MAX));
  return announcement;
}

/**
 * Removes a manual announcement by id.
 *
 * @param {string} id -> Announcement id.
 * @returns {boolean} -> True when an entry was removed.
 */
function deleteVersionAnnouncement(id) {
  log('deleteVersionAnnouncement called with: %o', { id });
  const list = listVersionAnnouncements();
  const next = list.filter((a) => a && a.id !== id);
  if (next.length === list.length) return false;
  writeJson(KEY.VERSION_ANNOUNCEMENTS, next);
  return true;
}

// ---------------------------------------------------------------------------
// Field mappings, markdown options, OpenWebUI mode, fallback targets
// ---------------------------------------------------------------------------

/**
 * Returns the logical-field -> Jira-field id mapping.
 *
 * @returns {Object} -> Mapping object keyed by LOGICAL_FIELDS values.
 */
function getFieldMappings() {
  return { ...DEFAULT_FIELD_MAPPINGS, ...readJson(KEY.FIELD_MAPPINGS, {}) };
}

/**
 * Persists the field mappings.
 *
 * @param {Object} mappings -> Mapping object.
 * @returns {void}
 */
function setFieldMappings(mappings) {
  log('setFieldMappings called');
  writeJson(KEY.FIELD_MAPPINGS, { ...DEFAULT_FIELD_MAPPINGS, ...(mappings || {}) });
}

/**
 * Returns the markdown template options.
 *
 * @returns {Object} -> Markdown options.
 */
function getMarkdownOptions() {
  return { ...DEFAULT_MARKDOWN_OPTIONS, ...readJson(KEY.MARKDOWN_OPTIONS, {}) };
}

/**
 * Persists the markdown template options.
 *
 * @param {Object} options -> Markdown options.
 * @returns {void}
 */
function setMarkdownOptions(options) {
  log('setMarkdownOptions called');
  writeJson(KEY.MARKDOWN_OPTIONS, { ...DEFAULT_MARKDOWN_OPTIONS, ...(options || {}) });
}

/**
 * Returns the OpenWebUI integration mode ('dummy' | 'real').
 *
 * @returns {string} -> Mode value.
 */
function getOpenWebUiMode() {
  const mode = readJson(KEY.OPENWEBUI_MODE, OPENWEBUI_MODE.DUMMY);
  return mode === OPENWEBUI_MODE.REAL ? OPENWEBUI_MODE.REAL : OPENWEBUI_MODE.DUMMY;
}

/**
 * Persists the OpenWebUI integration mode.
 *
 * @param {string} mode -> 'dummy' | 'real'.
 * @returns {void}
 */
function setOpenWebUiMode(mode) {
  log('setOpenWebUiMode called with: %o', { mode });
  writeJson(KEY.OPENWEBUI_MODE, mode === OPENWEBUI_MODE.REAL ? OPENWEBUI_MODE.REAL : OPENWEBUI_MODE.DUMMY);
}

// ---------------------------------------------------------------------------
// RAG / embedding configuration (OpenAI key stored encrypted inside the blob)
// ---------------------------------------------------------------------------

/**
 * Returns the RAG configuration merged with the defaults, with the OpenAI API
 * key decrypted. Never send the decrypted key to the browser.
 *
 * @returns {Object} -> { mode, ollamaUrl, model, dim, openaiApiKey }.
 */
function getRagConfig() {
  const raw = readJson(KEY.RAG, {});
  const mode = Object.values(RAG_MODE).includes(raw.mode) ? raw.mode : DEFAULT_RAG_CONFIG.mode;
  return {
    mode,
    ollamaUrl: typeof raw.ollamaUrl === 'string' && raw.ollamaUrl.trim()
      ? raw.ollamaUrl.trim().replace(/\/+$/, '')
      : DEFAULT_RAG_CONFIG.ollamaUrl,
    model: typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_RAG_CONFIG.model,
    dim: Number.isFinite(raw.dim) ? raw.dim : DEFAULT_RAG_CONFIG.dim,
    openaiApiKey: raw.openaiApiKey ? decrypt(raw.openaiApiKey) : '',
  };
}

/**
 * Persists the RAG configuration. The OpenAI API key is only overwritten when a
 * non-empty value is supplied, so the UI can submit a masked placeholder without
 * wiping the stored key.
 *
 * @param {Object} input -> Partial RAG config from the admin UI.
 * @returns {void}
 */
function setRagConfig(input) {
  log('setRagConfig called');
  const current = readJson(KEY.RAG, {});
  const mode = Object.values(RAG_MODE).includes(input.mode)
    ? input.mode
    : (current.mode || DEFAULT_RAG_CONFIG.mode);
  const next = {
    mode,
    ollamaUrl: input.ollamaUrl != null
      ? String(input.ollamaUrl).trim().replace(/\/+$/, '')
      : (current.ollamaUrl || DEFAULT_RAG_CONFIG.ollamaUrl),
    model: input.model != null ? String(input.model).trim() : (current.model || ''),
    dim: Number.isFinite(input.dim) ? input.dim : (current.dim || 0),
    openaiApiKey: current.openaiApiKey || '',
  };
  if (input.openaiApiKey) next.openaiApiKey = encrypt(input.openaiApiKey);
  writeJson(KEY.RAG, next);
}

/**
 * Returns the list of fallback knowledge-target ids used when no routing rule
 * matches a ticket.
 *
 * @returns {string[]} -> Target ids.
 */
function getFallbackTargetIds() {
  const ids = readJson(KEY.FALLBACK_TARGETS, []);
  return Array.isArray(ids) ? ids : [];
}

/**
 * Persists the fallback target ids.
 *
 * @param {string[]} ids -> Target ids.
 * @returns {void}
 */
function setFallbackTargetIds(ids) {
  log('setFallbackTargetIds called');
  writeJson(KEY.FALLBACK_TARGETS, Array.isArray(ids) ? ids : []);
}

// ---------------------------------------------------------------------------
// Webhook ingest toggle (Danger Zone: pause incoming Jira webhooks)
// ---------------------------------------------------------------------------

/**
 * Returns whether incoming Jira webhooks are processed. Defaults to true so a
 * fresh install behaves as before the pause switch existed.
 *
 * @returns {boolean} -> True when webhook processing is enabled.
 */
function getWebhookIngestEnabled() {
  return Boolean(readJson(KEY.WEBHOOK_INGEST, true));
}

/**
 * Persists the webhook ingest toggle.
 *
 * @param {boolean} enabled -> Whether incoming webhooks should be processed.
 * @returns {void}
 */
function setWebhookIngestEnabled(enabled) {
  log('setWebhookIngestEnabled called with: %o', { enabled });
  writeJson(KEY.WEBHOOK_INGEST, Boolean(enabled));
}

// ---------------------------------------------------------------------------
// Knowledge targets (decrypt token on read, encrypt on write)
// ---------------------------------------------------------------------------

/**
 * Maps a DB target row into a service-facing descriptor with decrypted token.
 *
 * @param {Object} row -> knowledge_targets row.
 * @returns {Object} -> { id, name, url, token, knowledgeId, enabled }.
 */
function rowToTarget(row) {
  return {
    id: row.id,
    name: row.name,
    url: (row.owui_url || '').replace(/\/$/, ''),
    token: row.owui_token_enc ? decrypt(row.owui_token_enc) : '',
    knowledgeId: row.knowledge_id || '',
    enabled: row.enabled === 1,
  };
}

/**
 * Returns all knowledge targets with decrypted tokens.
 *
 * @returns {Object[]} -> Target descriptors.
 */
function listTargets() {
  return queries.listTargets().map(rowToTarget);
}

/**
 * Returns a single knowledge target with decrypted token, or null.
 *
 * @param {string} id -> Target id.
 * @returns {Object|null} -> Target descriptor or null.
 */
function getTarget(id) {
  const row = queries.getTarget(id);
  return row ? rowToTarget(row) : null;
}

/**
 * Returns the enabled subset of targets matching the given ids, preserving the
 * caller's order and de-duplicating.
 *
 * @param {string[]} ids -> Target ids.
 * @returns {Object[]} -> Enabled target descriptors.
 */
function getTargetsByIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const t = getTarget(id);
    if (t && t.enabled) out.push(t);
  }
  return out;
}

/**
 * Creates a knowledge target. The token is encrypted before storage.
 *
 * @param {Object} input -> { name, url, token, knowledgeId, enabled }.
 * @returns {Object} -> The created target descriptor.
 */
function createTarget(input) {
  log('createTarget called');
  const id = crypto.randomUUID();
  queries.insertTarget({
    id,
    name: input.name || 'Wissensbasis',
    owuiUrl: input.url || null,
    owuiTokenEnc: input.token ? encrypt(input.token) : null,
    knowledgeId: input.knowledgeId || null,
    enabled: input.enabled === false ? 0 : 1,
  });
  version += 1;
  return getTarget(id);
}

/**
 * Updates a knowledge target. The token is only replaced when a non-empty value
 * is supplied (masked placeholders from the UI keep the existing secret).
 *
 * @param {string} id -> Target id.
 * @param {Object} input -> Partial fields.
 * @returns {Object|null} -> Updated descriptor or null if not found.
 */
function updateTarget(id, input) {
  log('updateTarget called with: %o', { id });
  const row = queries.getTarget(id);
  if (!row) return null;
  const tokenEnc = input.token ? encrypt(input.token) : row.owui_token_enc;
  queries.updateTarget(id, {
    name: input.name != null ? input.name : row.name,
    owuiUrl: input.url != null ? input.url : row.owui_url,
    owuiTokenEnc: tokenEnc,
    knowledgeId: input.knowledgeId != null ? input.knowledgeId : row.knowledge_id,
    enabled: input.enabled != null ? (input.enabled ? 1 : 0) : row.enabled,
  });
  version += 1;
  return getTarget(id);
}

/**
 * Deletes a knowledge target.
 *
 * @param {string} id -> Target id.
 * @returns {boolean} -> True if deleted.
 */
function deleteTarget(id) {
  log('deleteTarget called with: %o', { id });
  const ok = queries.deleteTarget(id);
  if (ok) {
    // Drop the deleted id from the fallback list to keep references valid.
    const fallback = getFallbackTargetIds().filter((x) => x !== id);
    setFallbackTargetIds(fallback);
    version += 1;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------

/**
 * Maps a DB rule row into a parsed descriptor.
 *
 * @param {Object} row -> routing_rules row.
 * @returns {Object} -> { id, name, enabled, sortOrder, conditions, ignoreConditions, targetIds, mcpIds }.
 */
function rowToRule(row) {
  let conditions = [];
  let ignoreConditions = [];
  let targetIds = [];
  let mcpIds = [];
  try {
    conditions = JSON.parse(row.conditions_json || '[]');
  } catch (_e) {
    conditions = [];
  }
  try {
    ignoreConditions = JSON.parse(row.ignore_conditions_json || '[]');
  } catch (_e) {
    ignoreConditions = [];
  }
  try {
    targetIds = JSON.parse(row.target_ids_json || '[]');
  } catch (_e) {
    targetIds = [];
  }
  try {
    mcpIds = JSON.parse(row.mcp_ids_json || '[]');
  } catch (_e) {
    mcpIds = [];
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    conditions,
    ignoreConditions,
    targetIds,
    mcpIds,
  };
}

/**
 * Returns all routing rules.
 *
 * @returns {Object[]} -> Rule descriptors.
 */
function listRules() {
  return queries.listRules().map(rowToRule);
}

/**
 * Creates a routing rule.
 *
 * @param {Object} input -> { name, enabled, sortOrder, conditions, targetIds }.
 * @returns {Object} -> The created rule descriptor.
 */
function createRule(input) {
  log('createRule called');
  const id = crypto.randomUUID();
  queries.insertRule({
    id,
    name: input.name || 'Regel',
    enabled: input.enabled === false ? 0 : 1,
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 0,
    conditionsJson: JSON.stringify(input.conditions || []),
    ignoreConditionsJson: JSON.stringify(input.ignoreConditions || []),
    targetIdsJson: JSON.stringify(input.targetIds || []),
    mcpIdsJson: JSON.stringify(input.mcpIds || []),
  });
  version += 1;
  return rowToRule(queries.listRules().find((r) => r.id === id));
}

/**
 * Updates a routing rule.
 *
 * @param {string} id -> Rule id.
 * @param {Object} input -> Partial fields.
 * @returns {Object|null} -> Updated descriptor or null if not found.
 */
function updateRule(id, input) {
  log('updateRule called with: %o', { id });
  const existing = queries.listRules().find((r) => r.id === id);
  if (!existing) return null;
  const current = rowToRule(existing);
  queries.updateRule(id, {
    name: input.name != null ? input.name : current.name,
    enabled: input.enabled != null ? input.enabled : current.enabled,
    sortOrder: input.sortOrder != null ? input.sortOrder : current.sortOrder,
    conditionsJson: JSON.stringify(input.conditions != null ? input.conditions : current.conditions),
    ignoreConditionsJson: JSON.stringify(input.ignoreConditions != null ? input.ignoreConditions : current.ignoreConditions),
    targetIdsJson: JSON.stringify(input.targetIds != null ? input.targetIds : current.targetIds),
    mcpIdsJson: JSON.stringify(input.mcpIds != null ? input.mcpIds : current.mcpIds),
  });
  version += 1;
  return rowToRule(queries.listRules().find((r) => r.id === id));
}

/**
 * Deletes a routing rule.
 *
 * @param {string} id -> Rule id.
 * @returns {boolean} -> True if deleted.
 */
function deleteRule(id) {
  log('deleteRule called with: %o', { id });
  const ok = queries.deleteRule(id);
  if (ok) version += 1;
  return ok;
}

// ---------------------------------------------------------------------------
// Admin auth (single password)
// ---------------------------------------------------------------------------

/**
 * Returns the stored admin auth record ({ salt, hash }) or null when unset.
 *
 * @returns {Object|null} -> Auth record.
 */
function getAuthConfig() {
  return readJson(KEY.AUTH, null);
}

/**
 * Persists the admin auth record.
 *
 * @param {Object} record -> { salt, hash }.
 * @returns {void}
 */
function setAuthConfig(record) {
  log('setAuthConfig called');
  writeJson(KEY.AUTH, record);
}

/**
 * Returns the stored user auth record ({ salt, hash }) or null when no user
 * password has been configured by the admin.
 *
 * @returns {Object|null} -> Auth record.
 */
function getUserAuthConfig() {
  return readJson(KEY.USER_AUTH, null);
}

/**
 * Persists the user auth record (or clears it when passed null).
 *
 * @param {Object|null} record -> { salt, hash } or null to remove the user login.
 * @returns {void}
 */
function setUserAuthConfig(record) {
  log('setUserAuthConfig called');
  writeJson(KEY.USER_AUTH, record);
}

// ---------------------------------------------------------------------------
// Access configuration (dashboard lock + user permissions)
// ---------------------------------------------------------------------------

/**
 * Returns the access configuration merged with the defaults so callers always
 * receive a complete object.
 *
 * @returns {Object} -> { dashboardLocked, userPermissions: { viewSettings, editSettings, manageLifecycle } }.
 */
function getAccessConfig() {
  const raw = readJson(KEY.ACCESS, {});
  const perms = (raw && typeof raw.userPermissions === 'object' && raw.userPermissions) || {};
  return {
    dashboardLocked: Boolean(raw.dashboardLocked),
    userPermissions: {
      viewSettings: Boolean(perms.viewSettings),
      editSettings: Boolean(perms.editSettings),
      manageLifecycle: Boolean(perms.manageLifecycle),
    },
  };
}

/**
 * Persists a (partial) access configuration, merging it onto the current value.
 * Editing settings implies viewing them, so editSettings forces viewSettings on.
 *
 * @param {Object} input -> Partial access config.
 * @returns {Object} -> The stored, normalized access config.
 */
function setAccessConfig(input) {
  log('setAccessConfig called');
  const current = getAccessConfig();
  const inPerms = (input && typeof input.userPermissions === 'object' && input.userPermissions) || {};
  const next = {
    dashboardLocked:
      input.dashboardLocked != null ? Boolean(input.dashboardLocked) : current.dashboardLocked,
    userPermissions: {
      viewSettings:
        inPerms.viewSettings != null ? Boolean(inPerms.viewSettings) : current.userPermissions.viewSettings,
      editSettings:
        inPerms.editSettings != null ? Boolean(inPerms.editSettings) : current.userPermissions.editSettings,
      manageLifecycle:
        inPerms.manageLifecycle != null
          ? Boolean(inPerms.manageLifecycle)
          : current.userPermissions.manageLifecycle,
    },
  };
  if (next.userPermissions.editSettings) next.userPermissions.viewSettings = true;
  writeJson(KEY.ACCESS, next);
  return next;
}

// ---------------------------------------------------------------------------
// MCP connection authentication (per-connection bearer token)
// ---------------------------------------------------------------------------

/**
 * Returns the decrypted bearer token of an MCP connection, or '' when none is
 * stored. Used to verify incoming Authorization headers on the MCP endpoint.
 *
 * @param {string} id -> Connection id.
 * @returns {string} -> Decrypted token or ''.
 */
function getMcpToken(id) {
  const conn = queries.getMcpConnection(id);
  return conn && conn.auth_token_enc ? decrypt(conn.auth_token_enc) : '';
}

/**
 * Returns an admin-facing view of an MCP connection's auth state.
 *
 * @param {string} id -> Connection id.
 * @returns {{requireAuth: boolean, hasToken: boolean, token: string}|null} -> View, or null if unknown.
 */
function getMcpAuthView(id) {
  const conn = queries.getMcpConnection(id);
  if (!conn) return null;
  const token = conn.auth_token_enc ? decrypt(conn.auth_token_enc) : '';
  return { requireAuth: conn.require_auth === 1, hasToken: Boolean(token), token };
}

/**
 * Generates and stores a fresh bearer token for an MCP connection.
 *
 * @param {string} id -> Connection id.
 * @returns {string|null} -> The new plaintext token, or null if the connection is unknown.
 */
function regenerateMcpToken(id) {
  log('regenerateMcpToken called with: %o', { id });
  const conn = queries.getMcpConnection(id);
  if (!conn) return null;
  const token = `kf_${crypto.randomBytes(24).toString('base64url')}`;
  queries.updateMcpConnectionAuth(id, { requireAuth: conn.require_auth === 1, authTokenEnc: encrypt(token) });
  version += 1;
  return token;
}

/**
 * Enables or disables bearer-token authentication for an MCP connection. When
 * enabling and no token exists yet, one is generated automatically so the
 * endpoint is never left "required but unauthenticatable".
 *
 * @param {string} id -> Connection id.
 * @param {boolean} enabled -> Whether to require authentication.
 * @returns {{requireAuth: boolean, hasToken: boolean, token: string, generated: string|null}|null} -> Resulting view, or null if unknown.
 */
function setMcpRequireAuth(id, enabled) {
  log('setMcpRequireAuth called with: %o', { id, enabled });
  const conn = queries.getMcpConnection(id);
  if (!conn) return null;
  let generated = null;
  if (enabled && !conn.auth_token_enc) {
    generated = regenerateMcpToken(id);
  }
  queries.updateMcpConnectionAuth(id, { requireAuth: enabled });
  version += 1;
  const view = getMcpAuthView(id);
  return { ...view, generated };
}

/**
 * Enables or disables the error-feedback capability for an MCP connection. When
 * enabled, the connection exposes the write-capable report_inaccuracy tool,
 * which posts a Jira comment and can move the ticket into a rework status.
 *
 * @param {string} id -> Connection id.
 * @param {boolean} enabled -> Whether to allow feedback.
 * @returns {{allowFeedback: boolean}|null} -> Resulting view, or null if unknown.
 */
function setMcpAllowFeedback(id, enabled) {
  log('setMcpAllowFeedback called with: %o', { id, enabled });
  const conn = queries.getMcpConnection(id);
  if (!conn) return null;
  queries.updateMcpConnectionFeedback(id, { allowFeedback: enabled });
  version += 1;
  return { allowFeedback: Boolean(enabled) };
}

// ---------------------------------------------------------------------------
// First-run setup wizard flag
// ---------------------------------------------------------------------------

/**
 * Returns whether the first-run setup wizard has already been completed. Once
 * true, the wizard never appears again (existing installs are also flagged via
 * a boot migration in index.js, so they skip the wizard permanently).
 *
 * @returns {boolean} -> True when initial setup is done.
 */
function isSetupCompleted() {
  return readJson(KEY.SETUP_COMPLETED, false) === true;
}

/**
 * Marks the first-run setup wizard as completed. Deliberately not reset by
 * resetRuntimeConfig(), so the Danger Zone reset cannot re-open the wizard and
 * let an attacker set a fresh admin password without the old one.
 *
 * @returns {void}
 */
function setSetupCompleted() {
  log('setSetupCompleted called');
  writeJson(KEY.SETUP_COMPLETED, true);
}

// ---------------------------------------------------------------------------
// Seeding from ENV (first boot)
// ---------------------------------------------------------------------------

/**
 * Populates the settings store from environment variables on first boot, so an
 * existing .env keeps working without manual reconfiguration. Idempotent: a
 * `seeded` flag prevents re-seeding (the DB becomes the source of truth).
 *
 * @returns {void}
 */
function ensureSeeded() {
  log('ensureSeeded called');
  if (readJson(KEY.SEEDED, false) === true) {
    log('settings already seeded, skipping');
    return;
  }

  // Jira config from ENV.
  const jiraToken = process.env.JIRA_API_TOKEN || '';
  const webhookSecret = process.env.JIRA_WEBHOOK_SECRET || '';
  writeJson(KEY.JIRA, {
    baseUrl: normalizeBaseUrl(process.env.JIRA_BASE_URL),
    email: process.env.JIRA_EMAIL || '',
    apiToken: jiraToken ? encrypt(jiraToken) : '',
    projectKeys: parseList(process.env.JIRA_PROJECT_KEYS),
    doneStatuses: parseList(process.env.JIRA_DONE_STATUS).length
      ? parseList(process.env.JIRA_DONE_STATUS)
      : ['Done'],
    reworkStatuses: parseList(process.env.JIRA_REWORK_STATUSES || 'Überarbeiten,Updaten'),
    webhookSecret: webhookSecret ? encrypt(webhookSecret) : '',
  });

  // Field mappings + markdown options defaults.
  writeJson(KEY.FIELD_MAPPINGS, { ...DEFAULT_FIELD_MAPPINGS });
  writeJson(KEY.MARKDOWN_OPTIONS, { ...DEFAULT_MARKDOWN_OPTIONS });

  // OpenWebUI mode from ENV.
  const mode = (process.env.OPENWEBUI_MODE || OPENWEBUI_MODE.DUMMY).toLowerCase() === OPENWEBUI_MODE.REAL
    ? OPENWEBUI_MODE.REAL
    : OPENWEBUI_MODE.DUMMY;
  writeJson(KEY.OPENWEBUI_MODE, mode);

  // Create a default knowledge target from the legacy single-KB ENV config and
  // mark it as the fallback so existing setups route exactly as before.
  const created = createTarget({
    name: 'Standard-Wissensbasis',
    url: process.env.OPENWEBUI_URL || '',
    token: process.env.OPENWEBUI_TOKEN || '',
    knowledgeId: process.env.OPENWEBUI_KNOWLEDGE_ID || '',
    enabled: true,
  });
  setFallbackTargetIds([created.id]);

  // Seed the admin password from ADMIN_PASSWORD if provided (hashed lazily by
  // authService at boot — here we only flip the seeded flag).
  writeJson(KEY.SEEDED, true);
  console.warn('[settingsService] Einstellungen aus ENV in die DB übernommen (erstmaliges Seeding).');
}

// ---------------------------------------------------------------------------
// Runtime config reset (Danger Zone)
// ---------------------------------------------------------------------------

/**
 * Resets the runtime configuration to the factory defaults. Deletes all
 * knowledge targets and routing rules, then restores the default Jira config,
 * field mappings, markdown options, OpenWebUI mode, fallback list and webhook
 * ingest toggle.
 *
 * The admin password (KEY.AUTH) and the seeding flag (KEY.SEEDED) are
 * deliberately left untouched: clearing AUTH would lock the admin out, and
 * clearing SEEDED would re-seed from ENV on the next restart and undo the reset.
 *
 * @returns {void}
 */
function resetRuntimeConfig() {
  log('resetRuntimeConfig called');

  // Drop all knowledge targets (cascades to ticket_uploads via FK) and rules.
  for (const target of queries.listTargets()) {
    queries.deleteTarget(target.id);
  }
  for (const rule of queries.listRules()) {
    queries.deleteRule(rule.id);
  }

  writeJson(KEY.JIRA, {});
  writeJson(KEY.FIELD_MAPPINGS, { ...DEFAULT_FIELD_MAPPINGS });
  writeJson(KEY.MARKDOWN_OPTIONS, { ...DEFAULT_MARKDOWN_OPTIONS });
  writeJson(KEY.OPENWEBUI_MODE, OPENWEBUI_MODE.DUMMY);
  writeJson(KEY.RAG, { ...DEFAULT_RAG_CONFIG });
  writeJson(KEY.FALLBACK_TARGETS, []);
  writeJson(KEY.WEBHOOK_INGEST, true);

  // Restore the update-check config and clear manual announcements. The
  // version-notice state (KEY.VERSION_STATE) is left untouched so a reset does
  // not re-trigger a notification for the already-installed version.
  writeJson(KEY.UPDATE_CHECK, {});
  writeJson(KEY.VERSION_ANNOUNCEMENTS, []);
}

module.exports = {
  KEY,
  getVersion,
  getJiraConfig,
  setJiraConfig,
  getUpdateCheckConfig,
  setUpdateCheckConfig,
  getTokenExpiryReminders,
  getVersionState,
  setVersionState,
  listVersionAnnouncements,
  addVersionAnnouncement,
  deleteVersionAnnouncement,
  getFieldMappings,
  setFieldMappings,
  getMarkdownOptions,
  setMarkdownOptions,
  getOpenWebUiMode,
  setOpenWebUiMode,
  getRagConfig,
  setRagConfig,
  getFallbackTargetIds,
  setFallbackTargetIds,
  getWebhookIngestEnabled,
  setWebhookIngestEnabled,
  resetRuntimeConfig,
  listTargets,
  getTarget,
  getTargetsByIds,
  createTarget,
  updateTarget,
  deleteTarget,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  getAuthConfig,
  setAuthConfig,
  getUserAuthConfig,
  setUserAuthConfig,
  getAccessConfig,
  setAccessConfig,
  getMcpToken,
  getMcpAuthView,
  regenerateMcpToken,
  setMcpRequireAuth,
  setMcpAllowFeedback,
  isSetupCompleted,
  setSetupCompleted,
  ensureSeeded,
};
