'use strict';

const crypto = require('crypto');
const express = require('express');
const debug = require('debug');

const jiraOAuthService = require('../services/jiraOAuthService');
const setupPinService = require('../services/setupPinService');
const { getRole } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { SESSION_ROLES } = require('../constants');

const log = debug('knowflow:routes:jiraOauth');

// Pending authorization states are kept in memory: the flow is short-lived and a
// restart mid-flow should invalidate it anyway.
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Builds the Jira OAuth 2.0 (3LO) router. It lets an operator connect KnowFlow to
 * a Jira Cloud site without handling an API token:
 *
 *   GET  /api/jira/oauth/status     -> whether OAuth is available/connected
 *   POST /api/jira/oauth/authorize  -> returns the Atlassian consent URL
 *   GET  /api/jira/oauth/callback   -> exchanges the code and stores the tokens
 *   POST /api/jira/oauth/disconnect -> drops the stored connection
 *
 * Access mirrors the rest of the app: during first run a valid setup session
 * (console PIN) is required, afterwards an admin or edit-permitted session.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.config -> App config (publicBaseUrl).
 * @param {Object} deps.settingsService -> Settings store.
 * @returns {import('express').Router} -> Configured router.
 */
function createJiraOAuthRouter({ config, settingsService }) {
  log('createJiraOAuthRouter called');
  const router = express.Router();

  const redirectUri = `${String(config.publicBaseUrl || '').replace(/\/$/, '')}/api/jira/oauth/callback`;
  const oauthLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

  /** @type {Map<string, {expiresAt: number, returnTo: string}>} */
  const pendingStates = new Map();

  /**
   * Drops expired authorization states so the map cannot grow unbounded.
   *
   * @returns {void}
   */
  function pruneStates() {
    const now = Date.now();
    for (const [state, entry] of pendingStates) {
      if (entry.expiresAt <= now) pendingStates.delete(state);
    }
  }

  /**
   * Whether the first-run wizard is still open (no admin password yet).
   *
   * @returns {boolean} -> True while setup is pending.
   */
  function isSetupPending() {
    return !settingsService.isSetupCompleted() && !settingsService.getAuthConfig();
  }

  /**
   * Guard for the flow-starting endpoints: during first run a valid setup session
   * is enough, afterwards the caller needs settings-edit rights.
   *
   * @param {import('express').Request} req -> Request.
   * @param {import('express').Response} res -> Response.
   * @param {import('express').NextFunction} next -> Next handler.
   * @returns {void}
   */
  function requireSetupOrEdit(req, res, next) {
    if (isSetupPending()) {
      const token = req.cookies?.[setupPinService.SETUP_COOKIE_NAME];
      if (setupPinService.verifySetupSession(token)) {
        next();
        return;
      }
      res.status(401).json({ error: 'Setup-Sitzung fehlt oder ist abgelaufen. Bitte den PIN erneut eingeben.' });
      return;
    }

    const role = getRole(req);
    if (role === SESSION_ROLES.ADMIN) {
      next();
      return;
    }
    if (role === SESSION_ROLES.USER && settingsService.getAccessConfig().userPermissions.editSettings) {
      next();
      return;
    }
    res.status(role ? 403 : 401).json({
      error: role ? 'Keine Berechtigung für diese Aktion.' : 'Nicht authentifiziert',
    });
  }

  /**
   * Redirects back into the UI with a result flag, so the wizard/admin page can
   * show the outcome inline.
   *
   * @param {import('express').Response} res -> Response.
   * @param {string} returnTo -> Application path to return to.
   * @param {Object} params -> Query parameters to append.
   * @returns {void}
   */
  function redirectBack(res, returnTo, params) {
    const target = new URL(returnTo || '/', config.publicBaseUrl);
    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }
    res.redirect(`${target.pathname}${target.search}`);
  }

  router.get('/status', (_req, res) => {
    const cfg = settingsService.getJiraConfig();
    res.json({
      available: jiraOAuthService.isConfigured(),
      connected: cfg.authMethod === 'oauth',
      accountName: cfg.accountName || '',
      siteUrl: cfg.baseUrl || '',
    });
  });

  router.post('/authorize', oauthLimiter, requireSetupOrEdit, (req, res) => {
    log('POST /authorize');
    if (!jiraOAuthService.isConfigured()) {
      res.status(503).json({
        error: 'Jira OAuth ist nicht eingerichtet. Bitte JIRA_OAUTH_CLIENT_ID und JIRA_OAUTH_CLIENT_SECRET in der .env setzen (siehe docs/JIRA_OAUTH.md).',
      });
      return;
    }

    pruneStates();
    const state = crypto.randomBytes(32).toString('base64url');
    // Only accept an app-internal path so the callback cannot become an open redirect.
    const requested = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '/';
    const returnTo = requested === '/' || /^\/[^/\\]/.test(requested) ? requested : '/';
    pendingStates.set(state, { expiresAt: Date.now() + STATE_TTL_MS, returnTo });

    try {
      res.json({ authUrl: jiraOAuthService.buildAuthorizeUrl({ redirectUri, state }) });
    } catch (err) {
      pendingStates.delete(state);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/callback', oauthLimiter, async (req, res) => {
    log('GET /callback');
    pruneStates();

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const pending = pendingStates.get(state);
    // The state proves this server started the flow; without it the callback is
    // either forged or expired.
    if (!pending) {
      redirectBack(res, '/', {
        jiraOauth: 'error',
        message: 'Die Jira-Anmeldung ist abgelaufen. Bitte erneut starten.',
      });
      return;
    }
    pendingStates.delete(state);

    if (req.query.error) {
      redirectBack(res, pending.returnTo, {
        jiraOauth: 'error',
        message: String(req.query.error_description || req.query.error),
      });
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      redirectBack(res, pending.returnTo, {
        jiraOauth: 'error',
        message: 'Atlassian hat keinen Autorisierungscode gesendet.',
      });
      return;
    }

    try {
      const connection = await jiraOAuthService.exchangeCode({ code, redirectUri });
      settingsService.setJiraOAuthConnection(connection);
      redirectBack(res, pending.returnTo, {
        jiraOauth: 'success',
        account: connection.accountName || '',
        site: connection.siteUrl || '',
      });
    } catch (err) {
      console.error('[jiraOauth] callback failed:', err.message);
      redirectBack(res, pending.returnTo, {
        jiraOauth: 'error',
        message: 'Die Jira-Verbindung konnte nicht hergestellt werden.',
      });
    }
  });

  router.post('/disconnect', oauthLimiter, requireSetupOrEdit, (_req, res) => {
    log('POST /disconnect');
    settingsService.clearJiraOAuth();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createJiraOAuthRouter };
