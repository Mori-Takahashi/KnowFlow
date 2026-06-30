'use strict';

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const debug = require('debug');

const { loadConfig } = require('./config');
const { upsertEnv } = require('./utils/envFile');
const setupPinService = require('./services/setupPinService');
const { openDatabase } = require('./db');
const settingsService = require('./services/settingsService');
const authService = require('./services/authService');
const { createJiraService } = require('./services/jiraService');
const { createOpenWebUiService } = require('./services/openwebuiService');
const { createRoutingService } = require('./services/routingService');
const { createAttachmentService } = require('./services/attachmentService');
const { createMcpService } = require('./services/mcpService');
const { createTicketLifecycleService } = require('./services/ticketLifecycleService');
const { createWorkflowService } = require('./services/workflowService');
const { createVersionService } = require('./services/versionService');
const socketService = require('./services/socketService');
const queries = require('./db/queries');
const { createWebhookRouter } = require('./routes/webhook');
const { createApiRouter } = require('./routes/api');
const { createAdminRouter } = require('./routes/admin');
const { createSetupRouter } = require('./routes/setup');
const { createMcpRouter } = require('./routes/mcp');
const { createOAuthRouter } = require('./routes/oauth');
const { createDebugRouter } = require('./routes/debug');
const { createOpenWebUiDummyRouter } = require('./routes/openwebuiDummy');
const { maskSecret } = require('./utils/mask');
const { securityHeaders } = require('./middleware/securityHeaders');
const { csrfProtection } = require('./middleware/csrf');
const { requireSession } = require('./middleware/auth');
const { MCP_CONNECTION_SEEDS, OPENWEBUI_MODE } = require('./constants');

const log = debug('knowflow:index');

/**
 * Prints a one-shot boot summary so the user can verify the effective config
 * (now read from the settings store) at startup.
 *
 * @param {Object} config -> The loaded infrastructure config.
 * @returns {void}
 */
function printBootSummary(config) {
  const jira = settingsService.getJiraConfig();
  const secretLine = jira.webhookSecret
    ? `aktiv (${maskSecret(jira.webhookSecret)}, ${jira.webhookSecret.length} Zeichen)`
    : 'aus';
  const targets = settingsService.listTargets();
  const auth = settingsService.getAuthConfig();
  const updateCheck = settingsService.getUpdateCheckConfig();

  const lines = [
    '===== KNOWFLOW BOOT =====',
    `Port: ${config.port}`,
    `Public Base URL: ${config.publicBaseUrl}`,
    `Jira Base URL: ${jira.baseUrl || '(nicht gesetzt)'}`,
    `Jira Project Keys: [${jira.projectKeys.join(', ')}]`,
    `Jira Done Statuses: [${jira.doneStatuses.join(', ')}]`,
    `Jira Rework Statuses: [${jira.reworkStatuses.join(', ')}]`,
    `Jira Webhook Secret: ${secretLine}`,
    `Open WebUI Mode: ${settingsService.getOpenWebUiMode()}`,
    `Update-Check: ${updateCheck.enabled ? `aktiv (${updateCheck.repo})` : 'deaktiviert'}`,
    `Wissensbasen: ${targets.length} konfiguriert`,
    `MCP-Endpoints: ${config.publicBaseUrl}/mcp/<id> (${MCP_CONNECTION_SEEDS.length} Verbindungen)`,
    `Admin-Login: ${auth ? 'aktiv' : 'deaktiviert — Ersteinrichtung über den Setup-Assistenten im Browser ausstehend'}`,
    `Webhook Debug: ${config.webhookDebug}`,
    `UI Debug: ${config.uiDebug}`,
    '========================',
  ];
  console.warn(lines.join('\n'));
}

/**
 * Ensures the infrastructure secrets exist before any config is loaded. On a
 * truly fresh checkout there may be no .env at all; rather than crashing in
 * loadConfig(), we generate a strong SETTINGS_ENCRYPTION_KEY (and SESSION_SECRET
 * when absent), inject them into process.env, and persist them to a .env file so
 * subsequent boots are stable. This is what lets the app start with no .env and
 * fall through to the browser setup wizard.
 *
 * @returns {void}
 */
function ensureBootSecrets() {
  const generated = {};
  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    const key = crypto.randomBytes(32).toString('hex');
    process.env.SETTINGS_ENCRYPTION_KEY = key;
    generated.SETTINGS_ENCRYPTION_KEY = key;
  }
  if (!process.env.SESSION_SECRET) {
    const secret = crypto.randomBytes(32).toString('hex');
    process.env.SESSION_SECRET = secret;
    generated.SESSION_SECRET = secret;
  }
  if (Object.keys(generated).length === 0) return;

  try {
    const written = upsertEnv(generated);
    console.warn(
      `[index] Keine Secrets gefunden — automatisch generiert und in .env gespeichert (${written.join(', ')}). ` +
        'Bitte die .env sichern: Bei Verlust von SETTINGS_ENCRYPTION_KEY sind verschlüsselte Tokens nicht mehr lesbar.',
    );
  } catch (err) {
    // Writing the .env can fail on a read-only filesystem (e.g. some PaaS). The
    // secrets still live in process.env for this run, but they will rotate on
    // every restart, so warn loudly instead of crashing.
    console.warn(
      `[index] Secrets generiert, aber .env konnte nicht geschrieben werden (${err.message}). ` +
        'SETTINGS_ENCRYPTION_KEY/SESSION_SECRET sollten dauerhaft in der Umgebung gesetzt werden.',
    );
  }
}

/**
 * Bootstraps the KnowFlow HTTP server, services, database, and Socket.IO.
 *
 * @returns {Promise<void>} -> Resolves once the server is listening.
 * @throws {Error} -> If a required config value is missing or the DB cannot be opened.
 */
async function main() {
  log('main called');

  ensureBootSecrets();

  const config = loadConfig();
  openDatabase(config.databasePath);

  // Move the legacy .env config into the DB on first boot, then make sure an
  // admin password exists (seeded from ADMIN_PASSWORD when present).
  settingsService.ensureSeeded();
  queries.seedMcpConnections(MCP_CONNECTION_SEEDS);
  authService.ensureAdminPassword();

  // Migration for existing installs: when an admin password already exists (e.g.
  // seeded from ADMIN_PASSWORD) but the setup flag is missing, flip it so the
  // first-run wizard never appears for installations that predate it.
  if (!settingsService.isSetupCompleted() && settingsService.getAuthConfig()) {
    settingsService.setSetupCompleted();
  }

  // First-run only: when the setup wizard is still pending, generate a one-shot
  // console PIN that gates the wizard. It rotates on every restart until setup
  // completes, so only someone with access to the server console can run it.
  const setupRequired = !settingsService.isSetupCompleted() && !settingsService.getAuthConfig();
  if (setupRequired) {
    setupPinService.generatePin();
  }

  printBootSummary(config);

  if (setupRequired) {
    setupPinService.printPin(config.publicBaseUrl);
  }

  const jiraService = createJiraService(settingsService);
  const openwebuiService = createOpenWebUiService(settingsService, config.dummyStorageDir);
  const routingService = createRoutingService(settingsService);
  const attachmentService = createAttachmentService({ jiraService, config });
  const mcpService = createMcpService({ config, attachmentService, jiraService, settingsService });
  const ticketLifecycleService = createTicketLifecycleService({ openwebuiService, settingsService, attachmentService });
  const workflowService = createWorkflowService({
    jiraService,
    openwebuiService,
    routingService,
    attachmentService,
    settingsService,
    config,
  });
  const versionService = createVersionService({ settingsService });

  const app = express();
  app.disable('x-powered-by');
  // Trust the first proxy hop (Railway and similar PaaS terminate TLS in front
  // of the app) so req.ip and req.protocol reflect the real client and secure
  // cookies / rate limiting behave correctly.
  app.set('trust proxy', 1);
  app.use(securityHeaders());
  app.use(cookieParser());
  app.use(csrfProtection());
  // Capture the raw body so the GitHub webhook handler can verify the HMAC
  // signature (X-Hub-Signature-256) over the exact bytes Express received.
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));

  // MCP endpoints must be mounted before the static middleware. express.json()
  // above applies here too, so the parsed body can be passed to the transport.
  app.use('/mcp', createMcpRouter({ mcpService, settingsService, config }));

  // OAuth 2.1 authorization server + protected-resource metadata for the MCP
  // endpoints (mounted at the root so the /.well-known/* discovery URLs resolve
  // on the public origin, as OAuth-only MCP clients like Claude expect).
  app.use(createOAuthRouter({ config, authService }));

  app.use('/webhook', createWebhookRouter({ workflowService, settingsService, versionService, config }));
  app.use(
    '/api',
    createApiRouter({
      workflowService,
      jiraService,
      openwebuiService,
      settingsService,
      authService,
      attachmentService,
      mcpService,
      versionService,
      config,
    }),
  );

  // Protected admin dashboard API (login + runtime configuration).
  app.use(
    '/api/admin',
    createAdminRouter({
      jiraService,
      openwebuiService,
      routingService,
      settingsService,
      authService,
      ticketLifecycleService,
      workflowService,
      versionService,
    }),
  );

  // Public first-run setup API (only active until the wizard is completed).
  app.use('/api/setup', createSetupRouter({ settingsService, authService, setupPinService, config }));

  // Debug controls for live demos. Only mounted when UI_DEBUG=true; when it is
  // off, /api/debug/* returns 404 and the WebUI hides the debug panel.
  if (config.uiDebug) {
    app.use('/api/debug', createDebugRouter({ workflowService, config }));
    console.warn('[index] UI_DEBUG aktiv: Debug-Endpunkte unter /api/debug/* verfügbar.');
  }

  if (settingsService.getOpenWebUiMode() === OPENWEBUI_MODE.DUMMY) {
    app.use('/openwebui-dummy', requireSession, createOpenWebUiDummyRouter(config.dummyStorageDir));
  }

  const publicDir = path.resolve(process.cwd(), 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use((err, _req, res, _next) => {
    // Log the full stack server-side, but never leak internal error details to
    // the client in production — return a generic message instead.
    console.error('[index] Unhandled error:', err.stack || err.message);
    const exposeDetails = process.env.NODE_ENV !== 'production';
    res
      .status(err.status || 500)
      .json({ error: exposeDetails ? err.message : 'Interner Serverfehler' });
  });

  const httpServer = http.createServer(app);
  socketService.attach(httpServer, { authService, settingsService });

  httpServer.listen(config.port, () => {
    console.warn(`KnowFlow läuft auf ${config.publicBaseUrl}`);
    console.warn(`Webhook-Endpoint: ${config.publicBaseUrl}/webhook/jira`);
    console.warn(`Open-WebUI-Modus: ${settingsService.getOpenWebUiMode()}`);
  });

  // Kick off the periodic GitHub releases poll once the server is up.
  versionService.startPeriodicCheck();
}

main().catch((err) => {
  console.error('Bootstrap fehlgeschlagen:', err.message);
  process.exit(1);
});
