'use strict';

const express = require('express');
const debug = require('debug');

const queries = require('../db/queries');
const socketService = require('../services/socketService');
const { upsertEnv } = require('../utils/envFile');
const { createRateLimiter } = require('../middleware/rateLimit');
const { ACTIVITY_KIND } = require('../constants');

const log = debug('knowflow:routes:setup');

// Infrastructure-level env keys the wizard is allowed to write to the .env file.
// Everything else (Jira/OpenWebUI/knowledge bases) lives in the DB and must NOT
// be written here, so the "DB is the source of truth" invariant is preserved.
const INFRA_ENV = {
  PUBLIC_BASE_URL: { type: 'string' },
  PORT: { type: 'port' },
  DATABASE_URL: { type: 'string' },
  WEBHOOK_DEBUG: { type: 'bool' },
  UI_DEBUG: { type: 'bool' },
};

/**
 * Validates and normalizes the optional infra env payload from the wizard against
 * the INFRA_ENV whitelist. Unknown keys are ignored; empty values are skipped.
 *
 * @param {Object} env -> Raw env object from the request body.
 * @returns {Object<string, string>} -> Sanitized key/value map ready for upsertEnv.
 * @throws {Error} -> On an invalid value for a known key.
 */
function sanitizeInfraEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const [key, spec] of Object.entries(INFRA_ENV)) {
    const raw = env[key];
    if (raw == null || String(raw).trim() === '') continue;
    const value = String(raw).trim();
    if (spec.type === 'port') {
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Ungültiger Wert für PORT: ${value}`);
      }
      out[key] = String(port);
    } else if (spec.type === 'bool') {
      const lowered = value.toLowerCase();
      if (lowered !== 'true' && lowered !== 'false') {
        throw new Error(`Ungültiger Wert für ${key}: ${value}`);
      }
      out[key] = lowered;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Builds the public first-run setup router. Unlike the admin router these
 * endpoints are intentionally unauthenticated by a session, because on the very
 * first boot there is no admin session yet. They are guarded two ways instead:
 *   1. Self-locking — as soon as an admin password exists (or the setup flag is
 *      set), every endpoint refuses, so they cannot be abused later.
 *   2. PIN-gated — POST /complete requires a short-lived setup session that is
 *      only issued after the console PIN is verified via POST /verify-pin.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.settingsService -> Settings store.
 * @param {Object} deps.authService -> Auth service (initial password + session).
 * @param {Object} deps.setupPinService -> Console-PIN + setup-session service.
 * @param {Object} deps.config -> Loaded infrastructure config (for status defaults).
 * @returns {import('express').Router} -> Configured router.
 */
function createSetupRouter({ settingsService, authService, setupPinService, config }) {
  log('createSetupRouter called');
  const router = express.Router();

  // Limit PIN guessing: a handful of attempts per IP per window. The PIN is
  // 6 digits and rotates every restart, so this makes brute force impractical.
  const pinLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Zu viele PIN-Versuche. Bitte später erneut versuchen.',
  });

  /**
   * Returns whether the first-run setup is still required. Required means the
   * setup flag is unset AND no admin password exists yet; either condition alone
   * permanently closes the wizard.
   *
   * @returns {boolean} -> True while the wizard may run.
   */
  function isSetupRequired() {
    return !settingsService.isSetupCompleted() && !settingsService.getAuthConfig();
  }

  /**
   * Returns whether the current request carries a valid setup session.
   *
   * @param {import('express').Request} req -> The incoming request.
   * @returns {boolean} -> True when the kf_setup cookie is valid.
   */
  function hasSetupSession(req) {
    const token = req.cookies?.[setupPinService.SETUP_COOKIE_NAME];
    return setupPinService.verifySetupSession(token);
  }

  router.get('/status', (_req, res) => {
    log('GET /status');
    const required = isSetupRequired();
    // While setup is pending, expose the current infra defaults so the wizard can
    // prefill the "Server & URLs" step. Never expose secrets here.
    const envDefaults = required
      ? {
          PUBLIC_BASE_URL: config.publicBaseUrl,
          PORT: String(config.port),
          DATABASE_URL: process.env.DATABASE_URL || './data/knowflow.sqlite',
          WEBHOOK_DEBUG: String(config.webhookDebug),
          UI_DEBUG: String(config.uiDebug),
        }
      : null;
    res.json({ required, pinRequired: required, envDefaults });
  });

  router.post('/verify-pin', pinLimiter, (req, res) => {
    log('POST /verify-pin');

    if (!isSetupRequired()) {
      res.status(403).json({ error: 'Die Ersteinrichtung wurde bereits abgeschlossen.' });
      return;
    }

    const pin = req.body?.pin;
    if (!setupPinService.verifyPin(typeof pin === 'string' ? pin.trim() : pin)) {
      res.status(401).json({ error: 'Falscher PIN. Bitte den PIN aus der Server-Konsole eingeben.' });
      return;
    }

    // Issue a short-lived setup session so the wizard can call /complete.
    res.cookie(
      setupPinService.SETUP_COOKIE_NAME,
      setupPinService.issueSetupSession(),
      setupPinService.cookieOptions(),
    );
    res.json({ ok: true });
  });

  router.post('/complete', (req, res) => {
    log('POST /complete');

    // Hard gate: never touch anything once the install is past first-run.
    if (!isSetupRequired()) {
      res.status(403).json({ error: 'Die Ersteinrichtung wurde bereits abgeschlossen.' });
      return;
    }

    // PIN gate: a valid setup session (obtained via /verify-pin) is mandatory.
    if (!hasSetupSession(req)) {
      res.status(401).json({ error: 'Setup-Sitzung fehlt oder ist abgelaufen. Bitte den PIN erneut eingeben.' });
      return;
    }

    const body = req.body || {};

    try {
      // 1. Validate the infra env payload before any writes so a bad request
      // leaves the install untouched.
      const infraEnv = sanitizeInfraEnv(body.env);

      // 2. Password is the only mandatory field. Validate before any writes so a
      // bad request leaves the install untouched.
      const password = body.password;
      if (typeof password !== 'string' || password.length < 6) {
        res.status(400).json({ error: 'Das Passwort muss mindestens 6 Zeichen lang sein.' });
        return;
      }

      // 3. Optional Jira config. setJiraConfig handles encryption and defaults.
      const jiraConfigured = body.jira && typeof body.jira === 'object';
      if (jiraConfigured) {
        settingsService.setJiraConfig(body.jira);
      }

      // 4. Optional OpenWebUI mode.
      if (body.openwebuiMode) {
        settingsService.setOpenWebUiMode(body.openwebuiMode);
      }

      // 5. Optional first knowledge base. Reuse the empty seeded default target
      // instead of creating a duplicate, and make sure it is a fallback target.
      const target = body.target;
      const targetHasValues = target
        && typeof target === 'object'
        && (target.url || target.knowledgeId || target.token);
      let knowledgeConfigured = false;
      if (targetHasValues) {
        const empty = settingsService
          .listTargets()
          .find((t) => !t.url && !t.token && !t.knowledgeId);
        let saved;
        if (empty) {
          saved = settingsService.updateTarget(empty.id, {
            name: target.name || empty.name,
            url: target.url,
            token: target.token,
            knowledgeId: target.knowledgeId,
            enabled: true,
          });
        } else {
          saved = settingsService.createTarget({
            name: target.name,
            url: target.url,
            token: target.token,
            knowledgeId: target.knowledgeId,
            enabled: true,
          });
        }
        knowledgeConfigured = true;
        const fallback = settingsService.getFallbackTargetIds();
        if (saved && !fallback.includes(saved.id)) {
          settingsService.setFallbackTargetIds([...fallback, saved.id]);
        }
      }

      // 6. Persist optional infra env values to the .env file. These only take
      // effect after a restart, which the UI tells the user.
      let envWritten = [];
      if (Object.keys(infraEnv).length > 0) {
        envWritten = upsertEnv(infraEnv);
      }

      // 7. Set the admin password. A false result means another request set a
      // password in the meantime (race) -> treat like an already-completed setup.
      const passwordSet = authService.setInitialPassword(password);
      if (!passwordSet) {
        res.status(403).json({ error: 'Die Ersteinrichtung wurde bereits abgeschlossen.' });
        return;
      }

      // 8. Flip the flag so the wizard never shows again, and retire the PIN.
      settingsService.setSetupCompleted();
      setupPinService.clearPin();

      // 9. Record the completion in the activity feed and push it live.
      const parts = [
        jiraConfigured ? 'Jira-Verbindung konfiguriert' : 'Jira-Verbindung übersprungen',
        knowledgeConfigured ? 'Wissensbasis konfiguriert' : 'Wissensbasis übersprungen',
      ];
      if (envWritten.length > 0) {
        parts.push(`Server-Einstellungen gespeichert (${envWritten.join(', ')})`);
      }
      const event = queries.insertEvent({
        kind: ACTIVITY_KIND.INFO,
        title: 'Ersteinrichtung abgeschlossen',
        detail: `Admin-Passwort gesetzt. ${parts.join(', ')}.`,
        source: 'Setup',
      });
      socketService.emitActivityNew(event);

      // 10. Clear the setup-session cookie and auto-login: issue a real admin
      // session so the user lands in the dashboard already authenticated.
      res.clearCookie(setupPinService.SETUP_COOKIE_NAME, { path: '/' });
      res.cookie(authService.COOKIE_NAME, authService.issueToken(), authService.cookieOptions());

      // 11. Done. Signal whether a restart is needed for the infra changes.
      res.json({ ok: true, restartRequired: envWritten.length > 0 });
    } catch (err) {
      // Validation-style errors (e.g. password too short from setInitialPassword,
      // or an invalid infra env value) are surfaced as 400; anything unexpected
      // becomes a 500.
      if (err instanceof Error && /(Passwort|Ungültiger Wert)/.test(err.message)) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error('[setup] complete failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSetupRouter };
