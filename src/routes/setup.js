'use strict';

const express = require('express');
const debug = require('debug');

const queries = require('../db/queries');
const socketService = require('../services/socketService');
const { ACTIVITY_KIND } = require('../constants');

const log = debug('knowflow:routes:setup');

/**
 * Builds the public first-run setup router. Unlike the admin router these
 * endpoints are intentionally unauthenticated, because on the very first boot
 * there is no session yet. They are self-locking instead: as soon as an admin
 * password exists (or the setup flag is set), every endpoint refuses to do
 * anything, so they cannot be abused on an already-configured installation.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.settingsService -> Settings store.
 * @param {Object} deps.authService -> Auth service (initial password + session).
 * @returns {import('express').Router} -> Configured router.
 */
function createSetupRouter({ settingsService, authService }) {
  log('createSetupRouter called');
  const router = express.Router();

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

  router.get('/status', (_req, res) => {
    log('GET /status');
    res.json({ required: isSetupRequired() });
  });

  router.post('/complete', (req, res) => {
    log('POST /complete');

    // Hard gate: never touch anything once the install is past first-run.
    if (!isSetupRequired()) {
      res.status(403).json({ error: 'Die Ersteinrichtung wurde bereits abgeschlossen.' });
      return;
    }

    const body = req.body || {};

    try {
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

      // 6. Set the admin password. A false result means another request set a
      // password in the meantime (race) -> treat like an already-completed setup.
      const passwordSet = authService.setInitialPassword(password);
      if (!passwordSet) {
        res.status(403).json({ error: 'Die Ersteinrichtung wurde bereits abgeschlossen.' });
        return;
      }

      // 7. Flip the flag so the wizard never shows again.
      settingsService.setSetupCompleted();

      // 8. Record the completion in the activity feed and push it live.
      const parts = [
        jiraConfigured ? 'Jira-Verbindung konfiguriert' : 'Jira-Verbindung übersprungen',
        knowledgeConfigured ? 'Wissensbasis konfiguriert' : 'Wissensbasis übersprungen',
      ];
      const event = queries.insertEvent({
        kind: ACTIVITY_KIND.INFO,
        title: 'Ersteinrichtung abgeschlossen',
        detail: `Admin-Passwort gesetzt. ${parts.join(', ')}.`,
        source: 'Setup',
      });
      socketService.emitActivityNew(event);

      // 9. Auto-login: issue a session cookie so the user lands in the dashboard
      // already authenticated.
      res.cookie(authService.COOKIE_NAME, authService.issueToken(), authService.cookieOptions());

      // 10. Done.
      res.json({ ok: true });
    } catch (err) {
      // Validation-style errors (e.g. password too short from setInitialPassword)
      // are surfaced as 400; anything unexpected becomes a 500.
      if (err instanceof Error && /Passwort/.test(err.message)) {
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
