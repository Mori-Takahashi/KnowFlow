'use strict';

const express = require('express');
const debug = require('debug');

const { requireAdmin, getRole } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { maskSecret } = require('../utils/mask');
const queries = require('../db/queries');
const socketService = require('../services/socketService');
const embeddingService = require('../services/embeddingService');
const { LOGICAL_FIELDS, ROUTING_OPERATORS, ACTIVITY_KIND, SESSION_ROLES } = require('../constants');

const log = debug('knowflow:routes:admin');

const LOGICAL_FIELD_VALUES = Object.values(LOGICAL_FIELDS);

/**
 * Builds the admin REST router. Login/logout/session are public; the remaining
 * routes are protected by permission-aware guards: admin-only actions use
 * requireAdmin, while configuration view/edit and ticket-lifecycle actions can
 * be delegated to an authenticated user when the access config allows it.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.jiraService -> Jira service (fields/health).
 * @param {Object} deps.openwebuiService -> OpenWebUI service (target health).
 * @param {Object} deps.routingService -> Routing service (preview).
 * @param {Object} deps.settingsService -> Settings store.
 * @param {Object} deps.authService -> Auth service.
 * @param {Object} deps.ticketLifecycleService -> Lifecycle service (obsolete/delete/restore).
 * @param {Object} deps.workflowService -> Workflow service (retry on restore).
 * @param {Object} deps.versionService -> Version service (update check + announcements).
 * @returns {import('express').Router} -> Configured router.
 */
function createAdminRouter({ jiraService, openwebuiService, routingService, settingsService, authService, ticketLifecycleService, workflowService, versionService }) {
  log('createAdminRouter called');
  const router = express.Router();

  // Throttle password guessing against the dashboard login.
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

  /**
   * Builds a guard that admits admins unconditionally and users only when the
   * given permission check passes against the current access config.
   *
   * @param {(perms: Object) => boolean} check -> User-permission predicate.
   * @returns {import('express').RequestHandler} -> The guard middleware.
   */
  function permissionGuard(check) {
    return (req, res, next) => {
      const role = getRole(req);
      if (role === SESSION_ROLES.ADMIN) {
        next();
        return;
      }
      if (role === SESSION_ROLES.USER) {
        if (check(settingsService.getAccessConfig().userPermissions)) {
          next();
          return;
        }
        res.status(403).json({ error: 'Keine Berechtigung für diese Aktion.' });
        return;
      }
      res.status(401).json({ error: 'Nicht authentifiziert' });
    };
  }

  // View needs at least read access; editing implies viewing.
  const requireView = permissionGuard((p) => p.viewSettings || p.editSettings);
  const requireEdit = permissionGuard((p) => p.editSettings);
  const requireLifecycle = permissionGuard((p) => p.manageLifecycle);

  // ---- Public auth routes -------------------------------------------------

  router.get('/session', (req, res) => {
    const role = getRole(req);
    let permissions = null;
    if (role === SESSION_ROLES.ADMIN) {
      permissions = { viewSettings: true, editSettings: true, manageLifecycle: true };
    } else if (role === SESSION_ROLES.USER) {
      permissions = settingsService.getAccessConfig().userPermissions;
    }
    res.json({ authenticated: Boolean(role), role: role || null, permissions });
  });

  router.post('/login', loginLimiter, (req, res) => {
    log('POST /login');
    const role = authService.authenticate(req.body?.password);
    if (!role) {
      res.status(401).json({ error: 'Falsches Passwort' });
      return;
    }
    res.cookie(authService.COOKIE_NAME, authService.issueToken(role), authService.cookieOptions());
    res.json({ ok: true, role });
  });

  router.post('/logout', (req, res) => {
    log('POST /logout');
    res.clearCookie(authService.COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // ---- Admin password (admin only) ----------------------------------------

  router.post('/password', requireAdmin, (req, res) => {
    log('POST /password');
    try {
      const ok = authService.changePassword(req.body?.current, req.body?.next);
      if (!ok) {
        res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Access control & user account (admin only) -------------------------

  router.get('/access-config', requireAdmin, (_req, res) => {
    log('GET /access-config');
    const access = settingsService.getAccessConfig();
    res.json({
      dashboardLocked: access.dashboardLocked,
      userPermissions: access.userPermissions,
      userLoginEnabled: authService.hasUserPassword(),
    });
  });

  router.put('/access-config', requireAdmin, (req, res) => {
    log('PUT /access-config');
    const next = settingsService.setAccessConfig(req.body || {});
    res.json({
      ok: true,
      dashboardLocked: next.dashboardLocked,
      userPermissions: next.userPermissions,
      userLoginEnabled: authService.hasUserPassword(),
    });
  });

  router.put('/user-password', requireAdmin, (req, res) => {
    log('PUT /user-password');
    try {
      const clear = req.body?.clear === true || !req.body?.password;
      const set = authService.setUserPassword(clear ? '' : req.body.password);
      res.json({ ok: true, userLoginEnabled: set });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- General config -----------------------------------------------------

  router.get('/config', requireView, (_req, res) => {
    log('GET /config');
    const jira = settingsService.getJiraConfig();
    res.json({
      jira: {
        baseUrl: jira.baseUrl,
        email: jira.email,
        projectKeys: jira.projectKeys,
        doneStatuses: jira.doneStatuses,
        reworkStatuses: jira.reworkStatuses,
        hasApiToken: Boolean(jira.apiToken),
        hasWebhookSecret: Boolean(jira.webhookSecret),
        webhookSecretMasked: jira.webhookSecret ? maskSecret(jira.webhookSecret) : '',
        apiTokenExpiresAt: jira.apiTokenExpiresAt,
      },
      openwebuiMode: settingsService.getOpenWebUiMode(),
      rag: (() => {
        const r = settingsService.getRagConfig();
        return {
          mode: r.mode,
          ollamaUrl: r.ollamaUrl,
          model: r.model,
          dim: r.dim,
          hasOpenaiApiKey: Boolean(r.openaiApiKey),
          openaiApiKeyMasked: r.openaiApiKey ? maskSecret(r.openaiApiKey) : '',
        };
      })(),
      fieldMappings: settingsService.getFieldMappings(),
      markdownOptions: settingsService.getMarkdownOptions(),
      fallbackTargetIds: settingsService.getFallbackTargetIds(),
      logicalFields: LOGICAL_FIELD_VALUES,
      operators: ROUTING_OPERATORS,
    });
  });

  router.put('/config/jira', requireEdit, (req, res) => {
    log('PUT /config/jira');
    try {
      settingsService.setJiraConfig(req.body || {});
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/config/markdown', requireEdit, (req, res) => {
    log('PUT /config/markdown');
    settingsService.setMarkdownOptions(req.body || {});
    res.json({ ok: true });
  });

  router.put('/config/openwebui-mode', requireEdit, (req, res) => {
    log('PUT /config/openwebui-mode');
    settingsService.setOpenWebUiMode(req.body?.mode);
    res.json({ ok: true, mode: settingsService.getOpenWebUiMode() });
  });

  // ---- RAG / semantic search ----------------------------------------------

  router.put('/config/rag', requireEdit, (req, res) => {
    log('PUT /config/rag');
    try {
      settingsService.setRagConfig(req.body || {});
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/config/rag/test', requireView, async (_req, res) => {
    log('POST /config/rag/test');
    try {
      const result = await embeddingService.testConnection();
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/config/rag/status', requireView, (_req, res) => {
    log('GET /config/rag/status');
    res.json(embeddingService.getStatus());
  });

  router.post('/config/rag/reindex', requireEdit, (_req, res) => {
    log('POST /config/rag/reindex');
    if (!embeddingService.isEnabled()) {
      res.status(400).json({ error: 'RAG ist nicht aktiviert.' });
      return;
    }
    // Fire-and-forget: the reindex runs in the background and reports progress
    // over Socket.IO. The request returns immediately so the UI stays responsive.
    embeddingService.reindexAll().catch((err) => {
      console.error('[admin] RAG reindex failed:', err.message);
    });
    res.json({ started: true });
  });

  router.put('/field-mappings', requireEdit, (req, res) => {
    log('PUT /field-mappings');
    settingsService.setFieldMappings(req.body || {});
    res.json({ ok: true });
  });

  router.put('/fallback-targets', requireEdit, (req, res) => {
    log('PUT /fallback-targets');
    const ids = Array.isArray(req.body?.targetIds) ? req.body.targetIds : [];
    settingsService.setFallbackTargetIds(ids);
    res.json({ ok: true });
  });

  // ---- Jira helpers -------------------------------------------------------

  router.get('/jira/fields', requireView, async (_req, res) => {
    log('GET /jira/fields');
    try {
      const fields = await jiraService.listFields();
      res.json({ fields });
    } catch (err) {
      res.status(502).json({ error: `Jira-Felder konnten nicht geladen werden: ${err.message}` });
    }
  });

  router.post('/jira/test', requireView, async (_req, res) => {
    log('POST /jira/test');
    try {
      const result = await jiraService.healthCheck();
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---- Knowledge targets --------------------------------------------------

  /**
   * Maps a decrypted target descriptor into a browser-safe shape (token hidden).
   *
   * @param {Object} t -> Target descriptor from settingsService.
   * @returns {Object} -> Safe representation.
   */
  function safeTarget(t) {
    return {
      id: t.id,
      name: t.name,
      url: t.url,
      knowledgeId: t.knowledgeId,
      enabled: t.enabled,
      hasToken: Boolean(t.token),
    };
  }

  router.get('/targets', requireView, (_req, res) => {
    log('GET /targets');
    res.json({ targets: settingsService.listTargets().map(safeTarget) });
  });

  router.post('/targets', requireEdit, (req, res) => {
    log('POST /targets');
    const target = settingsService.createTarget(req.body || {});
    res.status(201).json({ target: safeTarget(target) });
  });

  router.put('/targets/:id', requireEdit, (req, res) => {
    log('PUT /targets/:id');
    const updated = settingsService.updateTarget(req.params.id, req.body || {});
    if (!updated) {
      res.status(404).json({ error: 'Wissensbasis nicht gefunden' });
      return;
    }
    res.json({ target: safeTarget(updated) });
  });

  router.delete('/targets/:id', requireEdit, (req, res) => {
    log('DELETE /targets/:id');
    const ok = settingsService.deleteTarget(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Wissensbasis nicht gefunden' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/targets/:id/test', requireView, async (req, res) => {
    log('POST /targets/:id/test');
    const target = settingsService.getTarget(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Wissensbasis nicht gefunden' });
      return;
    }
    try {
      const result = await openwebuiService.healthCheck(target);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---- Routing rules ------------------------------------------------------

  /**
   * Validates a rule payload's conditions and target ids.
   *
   * @param {Object} body -> Rule payload.
   * @returns {string|null} -> Error message, or null when valid.
   */
  function validateRule(body) {
    if (!body || typeof body.name !== 'string' || !body.name.trim()) {
      return 'Regelname fehlt.';
    }
    if (!Array.isArray(body.conditions)) return 'conditions muss ein Array sein.';
    for (const c of body.conditions) {
      if (!LOGICAL_FIELD_VALUES.includes(c.field)) return `Unbekanntes Feld: ${c.field}`;
      if (!ROUTING_OPERATORS.includes(c.operator)) return `Unbekannter Operator: ${c.operator}`;
    }
    if (body.ignoreConditions != null) {
      if (!Array.isArray(body.ignoreConditions)) return 'ignoreConditions muss ein Array sein.';
      for (const c of body.ignoreConditions) {
        if (!LOGICAL_FIELD_VALUES.includes(c.field)) return `Unbekanntes Feld: ${c.field}`;
        if (!ROUTING_OPERATORS.includes(c.operator)) return `Unbekannter Operator: ${c.operator}`;
      }
    }
    if (!Array.isArray(body.targetIds)) return 'targetIds muss ein Array sein.';
    if (body.mcpIds != null) {
      if (!Array.isArray(body.mcpIds)) return 'mcpIds muss ein Array sein.';
      for (const id of body.mcpIds) {
        if (typeof id !== 'string' || !queries.getMcpConnection(id)) {
          return `Unbekannte MCP-Verbindung: ${id}`;
        }
      }
    }
    return null;
  }

  router.get('/rules', requireView, (_req, res) => {
    log('GET /rules');
    res.json({ rules: settingsService.listRules() });
  });

  router.post('/rules', requireEdit, (req, res) => {
    log('POST /rules');
    const err = validateRule(req.body);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    res.status(201).json({ rule: settingsService.createRule(req.body) });
  });

  router.put('/rules/:id', requireEdit, (req, res) => {
    log('PUT /rules/:id');
    const err = validateRule(req.body);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    const updated = settingsService.updateRule(req.params.id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Regel nicht gefunden' });
      return;
    }
    res.json({ rule: updated });
  });

  router.delete('/rules/:id', requireEdit, (req, res) => {
    log('DELETE /rules/:id');
    const ok = settingsService.deleteRule(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Regel nicht gefunden' });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/rules/preview', requireView, async (req, res) => {
    log('GET /rules/preview');
    const issueKey = (req.query.issueKey || '').toString().trim();
    if (!issueKey) {
      res.status(400).json({ error: 'issueKey fehlt' });
      return;
    }
    try {
      const issue = await jiraService.getIssue(issueKey);
      const { targets, mcpConnectionIds, matchedRules, usedFallback } = routingService.resolveTargets(issue);
      res.json({
        issueKey,
        summary: issue?.fields?.summary || null,
        matchedRules,
        usedFallback,
        targets: targets.map((t) => ({ id: t.id, name: t.name })),
        mcpConnectionIds,
      });
    } catch (err) {
      res.status(502).json({ error: `Vorschau fehlgeschlagen: ${err.message}` });
    }
  });

  // ---- MCP connections ----------------------------------------------------

  /**
   * Builds the browser-facing shape of an MCP connection. The bearer token is
   * only included for admins (token management is admin-only).
   *
   * @param {Object} c -> mcp_connections row.
   * @param {boolean} includeToken -> Whether to reveal the plaintext token.
   * @returns {Object} -> Connection descriptor.
   */
  function safeMcpConnection(c, includeToken) {
    const view = settingsService.getMcpAuthView(c.id) || { requireAuth: false, hasToken: false, token: '' };
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      isAll: c.is_all === 1,
      requireAuth: view.requireAuth,
      hasToken: view.hasToken,
      token: includeToken ? view.token : undefined,
      allowFeedback: c.allow_feedback === 1,
    };
  }

  router.get('/mcp-connections', requireView, (req, res) => {
    log('GET /mcp-connections');
    const isAdmin = getRole(req) === SESSION_ROLES.ADMIN;
    const connections = queries.listMcpConnections().map((c) => safeMcpConnection(c, isAdmin));
    res.json({ connections });
  });

  router.put('/mcp-connections/:id', requireEdit, (req, res) => {
    log('PUT /mcp-connections/:id %o', { id: req.params.id });
    const conn = queries.getMcpConnection(req.params.id);
    if (!conn) {
      res.status(404).json({ error: 'MCP-Verbindung nicht gefunden' });
      return;
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'Titel darf nicht leer sein.' });
      return;
    }
    const description = typeof req.body?.description === 'string' ? req.body.description : '';
    queries.updateMcpConnection(req.params.id, { title, description });
    const updated = queries.getMcpConnection(req.params.id);
    res.json({ connection: safeMcpConnection(updated, getRole(req) === SESSION_ROLES.ADMIN) });
  });

  router.put('/mcp-connections/:id/auth', requireAdmin, (req, res) => {
    log('PUT /mcp-connections/:id/auth %o', { id: req.params.id });
    const view = settingsService.setMcpRequireAuth(req.params.id, Boolean(req.body?.enabled));
    if (!view) {
      res.status(404).json({ error: 'MCP-Verbindung nicht gefunden' });
      return;
    }
    res.json({ requireAuth: view.requireAuth, hasToken: view.hasToken, token: view.token });
  });

  router.put('/mcp-connections/:id/feedback', requireAdmin, (req, res) => {
    log('PUT /mcp-connections/:id/feedback %o', { id: req.params.id });
    const view = settingsService.setMcpAllowFeedback(req.params.id, Boolean(req.body?.enabled));
    if (!view) {
      res.status(404).json({ error: 'MCP-Verbindung nicht gefunden' });
      return;
    }
    res.json({ allowFeedback: view.allowFeedback });
  });

  router.post('/mcp-connections/:id/token', requireAdmin, (req, res) => {
    log('POST /mcp-connections/:id/token %o', { id: req.params.id });
    const token = settingsService.regenerateMcpToken(req.params.id);
    if (!token) {
      res.status(404).json({ error: 'MCP-Verbindung nicht gefunden' });
      return;
    }
    res.json({ token });
  });

  // ---- Updates / Versionsbanner (admin only) ------------------------------

  router.get('/version/config', requireAdmin, (_req, res) => {
    log('GET /version/config');
    const cfg = settingsService.getUpdateCheckConfig();
    res.json({
      enabled: cfg.enabled,
      repo: cfg.repo,
      hasWebhookSecret: Boolean(cfg.githubWebhookSecret),
      hasGithubToken: Boolean(cfg.githubToken),
      githubTokenExpiresAt: cfg.githubTokenExpiresAt,
    });
  });

  router.put('/version/config', requireAdmin, (req, res) => {
    log('PUT /version/config');
    try {
      settingsService.setUpdateCheckConfig(req.body || {});
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    // When the check is enabled, refresh in the background so the new repo is
    // polled immediately without blocking the response.
    if (settingsService.getUpdateCheckConfig().enabled) {
      versionService.checkForUpdates({ force: true }).catch(() => {});
    }
    res.json({ ok: true });
  });

  router.post('/version/check', requireAdmin, async (_req, res) => {
    log('POST /version/check');
    const status = await versionService.checkForUpdates({ force: true });
    res.json(status);
  });

  router.post('/version/announce', requireAdmin, (req, res) => {
    log('POST /version/announce');
    try {
      const announcement = versionService.announce(req.body || {});
      res.status(201).json({ announcement });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/version/announcements/:id', requireAdmin, (req, res) => {
    log('DELETE /version/announcements/:id %o', { id: req.params.id });
    const ok = versionService.removeAnnouncement(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Ankündigung nicht gefunden' });
      return;
    }
    res.json({ ok: true });
  });

  // ---- Ticket lifecycle (soft delete / obsolete / restore) ----------------
  //
  // Admins always; users only when granted the manageLifecycle permission.

  router.post('/tickets/:id/obsolete', requireLifecycle, async (req, res) => {
    log('POST /tickets/:id/obsolete %o', { id: req.params.id });
    try {
      await ticketLifecycleService.setLifecycle(req.params.id, 'obsolete');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/tickets/:id/delete', requireLifecycle, async (req, res) => {
    log('POST /tickets/:id/delete %o', { id: req.params.id });
    try {
      await ticketLifecycleService.setLifecycle(req.params.id, 'deleted');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/tickets/:id/restore', requireLifecycle, async (req, res) => {
    log('POST /tickets/:id/restore %o', { id: req.params.id });
    try {
      await ticketLifecycleService.setLifecycle(req.params.id, 'active');
      // Re-run the pipeline asynchronously so the knowledge is rebuilt; respond
      // immediately (matches the public retry endpoint behavior).
      res.status(202).json({ ok: true, started: true });
      workflowService.retryTicket(req.params.id).catch((err) => {
        console.error('[admin] restore retry failed:', err.message);
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Danger Zone (admin only) -------------------------------------------
  //
  // Destructive, mostly irreversible maintenance actions. Every wiping action
  // re-checks the admin password in the request body (on top of the session),
  // so a left-open dashboard cannot be used to nuke data with a single click.

  /**
   * Re-verifies the admin password carried in the request body for a
   * destructive action. Sends a 401 and returns false when it is missing or
   * wrong, so callers can simply `if (!requireDangerPassword(req, res)) return;`.
   *
   * @param {import('express').Request} req -> Request (expects body.password).
   * @param {import('express').Response} res -> Response (used to send the 401).
   * @returns {boolean} -> True when the password is valid.
   */
  function requireDangerPassword(req, res) {
    if (!authService.verifyPassword(req.body?.password)) {
      res.status(401).json({ error: 'Admin-Passwort falsch oder fehlt.' });
      return false;
    }
    return true;
  }

  /**
   * Inserts an activity event and pushes it to connected dashboards over
   * Socket.IO (same mechanic as recordEvent in the ticket lifecycle service).
   *
   * @param {Object} args -> Event fields ({ kind, jiraId, title, detail, source }).
   * @returns {Object} -> The inserted event row.
   */
  function recordEvent(args) {
    const event = queries.insertEvent(args);
    socketService.emitActivityNew(event);
    return event;
  }

  router.get('/danger/status', requireAdmin, (_req, res) => {
    log('GET /danger/status');
    res.json({
      webhookIngestEnabled: settingsService.getWebhookIngestEnabled(),
      counts: {
        tickets: queries.countTickets(),
        events: queries.countEvents(),
      },
    });
  });

  router.put('/danger/webhook-ingest', requireAdmin, (req, res) => {
    log('PUT /danger/webhook-ingest');
    const enabled = Boolean(req.body?.enabled);
    settingsService.setWebhookIngestEnabled(enabled);
    if (enabled) {
      recordEvent({
        kind: ACTIVITY_KIND.INFO,
        title: 'Webhook-Verarbeitung aktiviert',
        detail: 'Eingehende Jira-Webhooks werden wieder verarbeitet.',
        source: 'Admin',
      });
    } else {
      recordEvent({
        kind: ACTIVITY_KIND.WARN,
        title: 'Webhook-Verarbeitung pausiert',
        detail: 'Eingehende Jira-Webhooks werden ignoriert.',
        source: 'Admin',
      });
    }
    res.json({ ok: true, enabled });
  });

  router.post('/danger/clear-events', requireAdmin, (req, res) => {
    log('POST /danger/clear-events');
    if (!requireDangerPassword(req, res)) return;
    const deleted = queries.deleteAllEvents();
    recordEvent({
      kind: ACTIVITY_KIND.INFO,
      title: 'Aktivitäts-Feed geleert',
      detail: `${deleted} Einträge entfernt.`,
      source: 'Admin',
    });
    res.json({ ok: true, deleted });
  });

  router.post('/danger/wipe-tickets', requireAdmin, async (req, res) => {
    log('POST /danger/wipe-tickets');
    if (!requireDangerPassword(req, res)) return;
    try {
      const { deleted } = await ticketLifecycleService.wipeAllTickets();
      res.json({ ok: true, deleted });
    } catch (err) {
      console.error('[admin] wipe-tickets failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/danger/reset-config', requireAdmin, (req, res) => {
    log('POST /danger/reset-config');
    if (!requireDangerPassword(req, res)) return;
    settingsService.resetRuntimeConfig();
    recordEvent({
      kind: ACTIVITY_KIND.WARN,
      title: 'Konfiguration zurückgesetzt',
      detail: 'Jira-Verbindung, Wissensbasen, Regeln und Vorlagen wurden auf den Auslieferungszustand gesetzt.',
      source: 'Admin',
    });
    res.json({ ok: true });
  });

  router.post('/danger/shutdown', requireAdmin, (req, res) => {
    log('POST /danger/shutdown');
    if (!requireDangerPassword(req, res)) return;
    recordEvent({
      kind: ACTIVITY_KIND.WARN,
      title: 'Dienst wird beendet',
      detail: 'Beendet durch Admin über die Danger Zone.',
      source: 'Admin',
    });
    res.json({ ok: true });
    // Exit shortly after responding so the client receives the acknowledgement
    // first. Under the process manager (Docker `restart: unless-stopped`) the
    // service comes back up automatically, so this acts as a remote restart.
    setTimeout(() => process.exit(0), 500);
  });

  return router;
}

module.exports = { createAdminRouter };
