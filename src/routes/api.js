'use strict';

const express = require('express');
const debug = require('debug');

const queries = require('../db/queries');
const debugState = require('../services/debugState');
const { TICKETS_PER_PAGE, TICKET_STATUS, TICKET_LIFECYCLE, HEALTH_CACHE_TTL_MS } = require('../constants');

const log = debug('knowflow:routes:api');

// Module-level cache for the /api/health response. The endpoint fans out to
// Jira and Open WebUI on every miss, and each browser tab polls this URL on
// load (plus a periodic refresh). Without a cache, opening the dashboard
// thrashes the external APIs and trips Jira's per-token rate limit. We store
// the full response (or the error message on failure) and serve it for the
// configured TTL window.
let healthCache = null;

/**
 * Maps a ticket DB row joined with its workflow_run into the UI ticket shape.
 *
 * @param {Object} row -> Row from listTickets / getTicket join.
 * @returns {Object} -> Ticket shape consumed by the WebUI.
 */
function rowToUiTicket(row) {
  log('rowToUiTicket called with: %o', { jiraId: row.jira_id });
  return {
    id: row.jira_id,
    title: row.summary,
    assignee: row.assignee || 'Unbekannt',
    reporter: row.reporter || 'Unbekannt',
    priority: row.priority || 'Mittel',
    jiraStatus: row.jira_status || '-',
    status: row.overall_status,
    wf: [
      row.step_1_status || 'idle',
      row.step_2_status || 'idle',
      row.step_3_status || 'idle',
    ],
    subs: [row.step_1_sub, row.step_2_sub, row.step_3_sub],
    uuid: row.openwebui_uuid || null,
    kbSize: row.markdown_size ? Math.round(row.markdown_size / 1024) : 0,
    lifecycle: row.lifecycle || 'active',
    updatedAt: row.updated_at,
    updated: humanizeAge(row.updated_at),
    error: row.run_error || null,
  };
}

/**
 * Builds the public attachment URL for a stored attachment row.
 *
 * @param {Object} config -> App config (publicBaseUrl).
 * @param {string} jiraId -> Issue key.
 * @param {string} attachmentId -> Jira attachment id.
 * @returns {string} -> Absolute download URL.
 */
function buildAttachmentUrl(config, jiraId, attachmentId) {
  return `${config.publicBaseUrl.replace(/\/$/, '')}/api/attachments/${encodeURIComponent(jiraId)}/${encodeURIComponent(attachmentId)}`;
}

/**
 * Formats a millisecond timestamp into a German "vor X" string.
 *
 * @param {number} ts -> Unix ms timestamp.
 * @returns {string} -> Human-friendly age.
 */
function humanizeAge(ts) {
  log('humanizeAge called with: %o', { ts });
  if (!ts) return '-';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'gerade eben';
  const min = Math.floor(sec / 60);
  if (min < 60) return `vor ${min} Min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `vor ${hrs} Std`;
  const days = Math.floor(hrs / 24);
  return `vor ${days} Tagen`;
}

/**
 * Applies any active debug health overrides onto a freshly built health
 * payload. In UI debug mode the presenter can force a service to appear 'down'
 * or 'warn'; this rewrites the matching block's status and label before the
 * payload is cached and returned. No-op when no overrides are set.
 *
 * @param {Object} payload -> The health payload (mutated copy returned).
 * @returns {Object} -> The payload with overrides applied.
 */
function applyHealthOverrides(payload) {
  const overrides = debugState.getHealthOverrides();
  const labels = { up: 'Betriebsbereit', warn: 'Erhöhte Latenz', down: 'Nicht erreichbar' };
  for (const [service, status] of Object.entries(overrides)) {
    if (payload[service]) {
      payload[service] = {
        ...payload[service],
        status,
        statusLabel: labels[status] || payload[service].statusLabel,
        debugOverride: true,
      };
    }
  }
  return payload;
}

/**
 * Builds the REST API router for the WebUI.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.workflowService -> Workflow service instance.
 * @param {Object} deps.jiraService -> Jira service for health checks.
 * @param {Object} deps.openwebuiService -> Open WebUI service for health checks.
 * @param {Object} deps.settingsService -> Settings store (mode + targets).
 * @param {Object} deps.authService -> Auth service (session role + access state).
 * @param {Object} deps.attachmentService -> Attachment service (resolveLocalPath).
 * @param {Object} deps.mcpService -> MCP service (listConnectionsWithStats).
 * @param {Object} deps.versionService -> Version service (update status).
 * @param {Object} deps.config -> App config.
 * @returns {import('express').Router} -> Configured router.
 */
function createApiRouter({ workflowService, jiraService, openwebuiService, settingsService, authService, attachmentService, mcpService, versionService, config }) {
  log('createApiRouter called');
  const router = express.Router();

  /**
   * Resolves the session role from the request cookie.
   *
   * @param {import('express').Request} req -> The request.
   * @returns {string|null} -> SESSION_ROLES value, or null.
   */
  function sessionRole(req) {
    const token = req.cookies ? req.cookies[authService.COOKIE_NAME] : null;
    return authService.getSessionRole(token);
  }

  // Public probe: reports the lock state and the caller's session so the WebUI
  // can decide whether to show the dashboard or a login screen. Must stay
  // reachable even while the dashboard is locked, so it sits before the gate.
  router.get('/access', (req, res) => {
    log('GET /api/access');
    const access = settingsService.getAccessConfig();
    const role = sessionRole(req);
    let permissions = null;
    if (role === 'admin') {
      permissions = { viewSettings: true, editSettings: true, manageLifecycle: true };
    } else if (role === 'user') {
      permissions = access.userPermissions;
    }
    res.json({
      dashboardLocked: access.dashboardLocked,
      userLoginEnabled: authService.hasUserPassword(),
      authenticated: Boolean(role),
      role: role || null,
      permissions,
    });
  });

  // Dashboard lock gate: when enabled, every data endpoint below requires a
  // valid session (admin or user). The /api router is mounted at "/api", so it
  // also sees requests destined for the separately mounted /api/admin,
  // /api/setup and /api/debug routers — those must stay reachable (login,
  // first-run setup, debug) regardless of the lock, otherwise enabling the lock
  // would lock everyone out of the login itself.
  const GATE_EXEMPT = /^\/(admin|setup|debug)(\/|$)/;
  router.use((req, res, next) => {
    if (GATE_EXEMPT.test(req.path)) {
      next();
      return;
    }
    if (!settingsService.getAccessConfig().dashboardLocked) {
      next();
      return;
    }
    if (sessionRole(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Anmeldung erforderlich.', locked: true });
  });

  // Let the debug route drop the cached health payload so a forced
  // service status takes effect on the next request instead of after the TTL.
  debugState.registerHealthCacheInvalidator(() => {
    healthCache = null;
  });

  router.get('/health', async (_req, res) => {
    log('GET /api/health');

    // Serve from cache while the TTL window is still valid. The knowflow block
    // is rebuilt on every request so uptime stays fresh even on a cache hit.
    const now = Date.now();
    if (healthCache && now - healthCache.timestamp < HEALTH_CACHE_TTL_MS) {
      if (healthCache.error) {
        res.status(500).json({ error: healthCache.error });
        return;
      }
      res.json({
        ...healthCache.payload,
        knowflow: {
          ...healthCache.payload.knowflow,
          uptime: humanizeUptime(process.uptime()),
        },
      });
      return;
    }

    try {
      const mode = settingsService.getOpenWebUiMode();
      const enabledTargets = settingsService.listTargets().filter((t) => t.enabled);
      const owuiTarget = enabledTargets[0] || null;
      const [jira, owui] = await Promise.all([
        jiraService.healthCheck(),
        openwebuiService.healthCheck(owuiTarget),
      ]);
      const payload = {
        knowflow: {
          name: 'KnowFlow Service',
          icon: 'bi-robot',
          iconClass: '',
          status: 'up',
          statusLabel: 'Betriebsbereit',
          version: 'PoC',
          uptime: humanizeUptime(process.uptime()),
          latency: '1 ms',
          queue: '0 wartend',
        },
        openwebui: {
          name: 'OpenWebUI',
          icon: 'bi-cloud-arrow-up',
          iconClass: 'green',
          status: owui.status,
          statusLabel: owui.statusLabel,
          version: owui.version,
          uptime: '-',
          latency: `${owui.latencyMs} ms`,
          queue: mode === 'dummy' ? 'Dummy-Modus aktiv' : `${enabledTargets.length} Wissensbasis(en)`,
        },
        jira: {
          name: 'Jira API',
          icon: 'bi-link-45deg',
          iconClass: 'purple',
          status: jira.status,
          statusLabel: jira.statusLabel,
          version: 'Cloud',
          uptime: '-',
          latency: `${jira.latencyMs} ms`,
          queue: 'Webhook aktiv',
        },
      };
      applyHealthOverrides(payload);
      healthCache = { timestamp: now, payload, error: null };
      res.json(payload);
    } catch (err) {
      console.error('[api] /health failed:', err.message);
      // Cache failures as well, otherwise a single Jira 429 turns into a
      // retry storm against the same rate-limited endpoint.
      healthCache = { timestamp: now, payload: null, error: err.message };
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/version', async (_req, res) => {
    log('GET /api/version');
    try {
      let status = versionService.getStatus();
      // First visit after boot: run a (cached, failure-tolerant) check so the
      // dashboard gets a populated status instead of an empty one.
      if (status.enabled && status.lastCheckedAt == null) {
        status = await versionService.checkForUpdates({});
      }
      // Attach token-expiry reminders so the dashboard can warn about API tokens
      // that are about to lapse, without coupling versionService to settings.
      res.json({ ...status, tokenReminders: settingsService.getTokenExpiryReminders() });
    } catch (err) {
      console.error('[api] /version failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tickets', (req, res) => {
    log('GET /api/tickets %o', req.query);
    try {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const filter = (req.query.filter || 'all').toString();
      const query = (req.query.q || '').toString();

      const total = queries.countTickets({ status: filter, query });
      const rows = queries.listTickets({
        limit: TICKETS_PER_PAGE,
        offset: (page - 1) * TICKETS_PER_PAGE,
        status: filter,
        query,
      });
      const counts = queries.countTicketsByStatus();

      res.json({
        page,
        perPage: TICKETS_PER_PAGE,
        total,
        counts,
        tickets: rows.map(rowToUiTicket),
      });
    } catch (err) {
      console.error('[api] /tickets failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tickets/:id', (req, res) => {
    log('GET /api/tickets/:id %o', { id: req.params.id });
    try {
      const ticket = queries.getTicket(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
      const run = queries.getWorkflowRun(req.params.id);
      const ui = rowToUiTicket({
        ...ticket,
        step_1_status: run?.step_1_status,
        step_1_sub: run?.step_1_sub,
        step_1_at: run?.step_1_at,
        step_2_status: run?.step_2_status,
        step_2_sub: run?.step_2_sub,
        step_2_at: run?.step_2_at,
        step_3_status: run?.step_3_status,
        step_3_sub: run?.step_3_sub,
        step_3_at: run?.step_3_at,
        run_error: run?.error,
      });
      ui.markdown = ticket.markdown || '';
      ui.stepTimes = [run?.step_1_at, run?.step_2_at, run?.step_3_at].map(humanizeAge);
      ui.attachments = queries.listTicketAttachments(req.params.id).map((a) => ({
        id: a.jira_attachment_id,
        filename: a.filename,
        mimeType: a.mime_type,
        size: a.size,
        status: a.status,
        url: buildAttachmentUrl(config, req.params.id, a.jira_attachment_id),
      }));
      res.json(ui);
    } catch (err) {
      console.error('[api] /tickets/:id failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/attachments/:jiraId/:attachmentId', (req, res) => {
    log('GET /api/attachments/:jiraId/:attachmentId %o', { jiraId: req.params.jiraId, attachmentId: req.params.attachmentId });
    try {
      const row = queries.getTicketAttachment(req.params.jiraId, req.params.attachmentId);
      if (!row || row.status !== 'stored') {
        res.status(404).json({ error: 'Anhang nicht gefunden' });
        return;
      }
      const ticket = queries.getTicket(req.params.jiraId);
      if (!ticket || ticket.lifecycle === TICKET_LIFECYCLE.DELETED) {
        res.status(404).json({ error: 'Anhang nicht gefunden' });
        return;
      }
      let absPath;
      try {
        absPath = attachmentService.resolveLocalPath(row);
      } catch (err) {
        res.status(404).json({ error: 'Anhang nicht gefunden' });
        return;
      }
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      // Sanitize the filename for the quoted form and provide a UTF-8 fallback
      // via filename* so umlauts survive.
      const asciiName = row.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      );
      res.sendFile(absPath, (err) => {
        if (err && !res.headersSent) {
          res.status(404).json({ error: 'Anhang nicht gefunden' });
        }
      });
    } catch (err) {
      console.error('[api] /attachments failed:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  router.get('/mcp/connections', (_req, res) => {
    log('GET /api/mcp/connections');
    try {
      const connections = mcpService.listConnectionsWithStats().map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        endpoint: c.endpoint,
        docCount: c.docCount,
        totalBytes: c.totalBytes,
        isAll: c.isAll,
      }));
      res.json({ connections });
    } catch (err) {
      console.error('[api] /mcp/connections failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/stats', (_req, res) => {
    log('GET /api/stats');
    try {
      const dash = queries.getDashboardStats();
      const throughput = queries.throughputByDay(7);
      const funnel = queries.funnelCounts();
      res.json({
        totalProcessed: dash.totalProcessed,
        thisWeek: dash.thisWeek,
        inProgress: dash.inProgress,
        errors: dash.errors,
        rework: dash.rework,
        knowledgeMb: +(dash.knowledgeBytes / (1024 * 1024)).toFixed(2),
        knowledgeBytes: dash.knowledgeBytes,
        throughput,
        funnel,
      });
    } catch (err) {
      console.error('[api] /stats failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/activity', (req, res) => {
    log('GET /api/activity');
    try {
      const limit = Math.min(200, Number.parseInt(req.query.limit, 10) || 50);
      const rows = queries.listEvents(limit);
      res.json(rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        jiraId: r.jira_id,
        title: r.title,
        detail: r.detail,
        source: r.source,
        createdAt: r.created_at,
        age: humanizeAge(r.created_at),
      })));
    } catch (err) {
      console.error('[api] /activity failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/knowledge', (_req, res) => {
    log('GET /api/knowledge');
    try {
      const rows = queries.listTickets({
        limit: 200,
        offset: 0,
        status: null,
        query: '',
      });
      const docs = rows
        .filter((r) => r.openwebui_uuid && r.lifecycle !== TICKET_LIFECYCLE.DELETED)
        .map((r) => ({
          id: r.jira_id,
          title: r.summary,
          uuid: r.openwebui_uuid,
          kbSize: r.markdown_size ? Math.round(r.markdown_size / 1024) : 0,
          updated: humanizeAge(r.updated_at),
          priority: r.priority,
          status: r.overall_status,
          markdown: r.markdown,
        }));
      res.json({ docs });
    } catch (err) {
      console.error('[api] /knowledge failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tickets/:id/retry', (req, res) => {
    log('POST /api/tickets/:id/retry %o', { id: req.params.id });
    try {
      const ticket = queries.getTicket(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
      if ((ticket.lifecycle || 'active') !== TICKET_LIFECYCLE.ACTIVE) {
        return res.status(409).json({
          error: 'Ticket ist veraltet oder gelöscht. Bitte zuerst im Tab Einstellungen reaktivieren.',
        });
      }
      res.status(202).json({ ok: true, started: true });
      workflowService.retryTicket(req.params.id).catch((err) => {
        console.error('[api] retry failed:', err.message);
      });
    } catch (err) {
      console.error('[api] /retry failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sync', (req, res) => {
    log('POST /api/sync');
    try {
      // For the PoC: resync = re-run pipeline for all tickets currently in 'err'.
      const errors = queries.listTickets({
        limit: 100,
        offset: 0,
        status: TICKET_STATUS.ERR,
      });
      res.status(202).json({ ok: true, scheduled: errors.length });
      for (const row of errors) {
        workflowService.retryTicket(row.jira_id).catch((err) => {
          console.error('[api] sync retry failed:', err.message);
        });
      }
    } catch (err) {
      console.error('[api] /sync failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Formats a process uptime (seconds) into a "Xd Yh Zm" string.
 *
 * @param {number} seconds -> Process uptime.
 * @returns {string} -> Human readable.
 */
function humanizeUptime(seconds) {
  log('humanizeUptime called with: %o', { seconds });
  const sec = Math.floor(seconds);
  const days = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  return `${days}d ${hrs}h ${mins}m`;
}

module.exports = { createApiRouter };
