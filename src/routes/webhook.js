'use strict';

const crypto = require('crypto');
const express = require('express');
const debug = require('debug');

const { maskSecret, maskInBody } = require('../utils/mask');
const { createRateLimiter } = require('../middleware/rateLimit');

const log = debug('knowflow:routes:webhook');

const BODY_PREVIEW_LIMIT = 4000;
const SEPARATOR_TOP = '===== WEBHOOK DEBUG =====';
const SEPARATOR_BOTTOM = '=========================';

// Only events that can carry a real status transition. Anything else (especially
// comment_created/updated/deleted) must be filtered out — otherwise the bot's
// own status-update comments would re-trigger the pipeline in a tight loop.
const STATUS_CHANGE_EVENTS = new Set([
  'jira:issue_updated',
  'jira:issue_generic',
]);

/**
 * Extracts the new status name from a Jira webhook changelog entry.
 * Only returns a value when the changelog actually contains a status field
 * change. We deliberately do NOT fall back to issue.fields.status.name, because
 * that field reflects the current ticket state and would also be set on
 * comment/attachment events, causing infinite feedback loops.
 *
 * @param {Object} payload -> Webhook body.
 * @returns {string|null} -> New status name on a real transition, else null.
 */
function extractStatusTransition(payload) {
  const items = payload?.changelog?.items || [];
  for (const item of items) {
    if (item.field === 'status' && item.toString) return item.toString;
  }
  return null;
}

/**
 * Checks whether the issue belongs to one of the configured project keys.
 *
 * @param {Object} payload -> Webhook body.
 * @param {string[]} allowedKeys -> Allowed project keys.
 * @returns {boolean} -> True if the project is allowed (or no filter set).
 */
function isAllowedProject(payload, allowedKeys) {
  if (!allowedKeys || allowedKeys.length === 0) return true;
  const projectKey = payload?.issue?.fields?.project?.key;
  if (!projectKey) return false;
  return allowedKeys.includes(projectKey);
}

/**
 * Validates the optional X-Hub-Signature-like secret header.
 * For the PoC we accept either header equality on X-KnowFlow-Secret.
 *
 * @param {import('express').Request} req -> Request.
 * @param {string} secret -> Expected secret, may be empty (disabled).
 * @returns {boolean} -> True if accepted.
 */
function isWebhookAuthorized(req, secret) {
  if (!secret) return true;
  const provided = req.get('X-KnowFlow-Secret') || req.query.secret;
  return provided === secret;
}

/**
 * Case-insensitive membership check for status names.
 *
 * @param {string} status -> Incoming status name.
 * @param {string[]} list -> Configured list of allowed status names.
 * @returns {boolean} -> True if status matches any entry, case-insensitive.
 */
function matchesAnyStatus(status, list) {
  if (!status || !Array.isArray(list)) return false;
  const lower = status.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === lower);
}

/**
 * Builds a JSON string for the body preview, truncated to BODY_PREVIEW_LIMIT.
 *
 * @param {Object|undefined} body -> Express-parsed request body.
 * @returns {string} -> Stringified body, possibly truncated with a hint.
 */
function previewBody(body) {
  if (body === undefined || body === null) return '(leer)';
  let json;
  try {
    json = JSON.stringify(body);
  } catch (err) {
    return `(nicht serialisierbar: ${err.message})`;
  }
  if (json.length <= BODY_PREVIEW_LIMIT) return json;
  return `${json.slice(0, BODY_PREVIEW_LIMIT)} … [gekürzt, ${json.length} Zeichen gesamt]`;
}

/**
 * Returns the ISO timestamp of the current moment.
 *
 * @returns {string} -> Current time as ISO 8601 string.
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Prints the verbose multi-line debug block for a single webhook request.
 * Uses console.warn so the block is visible without setting the DEBUG env
 * variable; gating is done by the WEBHOOK_DEBUG config flag at the call site.
 *
 * @param {Object} args -> Bundle of all log fields.
 * @param {import('express').Request} args.req -> Incoming request.
 * @param {Object} args.payload -> Parsed request body.
 * @param {Object} args.config -> App config.
 * @param {string|null} args.issueKey -> Extracted issue key.
 * @param {string|null} args.newStatus -> Extracted new status.
 * @param {string|null} args.projectKey -> Extracted project key.
 * @param {string|null} args.reporterAccountId -> Reporter accountId from payload.
 * @param {Object} args.decisions -> Per-stage decision results.
 * @param {string} args.finalPath -> Final routing decision label.
 * @returns {void}
 */
function printDebugBlock({
  req,
  payload,
  config,
  issueKey,
  newStatus,
  projectKey,
  reporterAccountId,
  decisions,
  finalPath,
}) {
  const headers = {
    host: req.get('host') || '(fehlt)',
    'user-agent': req.get('user-agent') || '(fehlt)',
    'content-type': req.get('content-type') || '(fehlt)',
    'x-knowflow-secret': req.get('x-knowflow-secret')
      ? maskSecret(req.get('x-knowflow-secret'))
      : '(fehlt)',
    'x-atlassian-webhook-identifier':
      req.get('x-atlassian-webhook-identifier') || '(fehlt)',
  };

  const maskedQuery = maskInBody(req.query || {}, ['secret']);

  const lines = [];
  lines.push(SEPARATOR_TOP);
  lines.push(`Empfangszeit: ${nowIso()}`);
  lines.push(`Methode: ${req.method}`);
  lines.push(`Pfad: ${req.path}`);
  lines.push('Headers:');
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`  ${key}: ${value}`);
  }
  lines.push(`Query-Parameter: ${JSON.stringify(maskedQuery)}`);
  lines.push(`Request-Body: ${previewBody(payload)}`);
  lines.push('Extrahierte Werte:');
  lines.push(`  webhookEvent: ${payload?.webhookEvent ?? 'nicht erkannt'}`);
  lines.push(`  issueKey: ${issueKey ?? 'nicht erkannt'}`);
  lines.push(`  newStatus: ${newStatus ?? 'nicht erkannt'}`);
  lines.push(`  projectKey: ${projectKey ?? 'nicht erkannt'}`);
  lines.push(`  reporter.accountId: ${reporterAccountId ?? 'fehlt'}`);
  lines.push('Entscheidungen:');
  lines.push(`  Secret-Prüfung: ${decisions.secret}`);
  lines.push(`  Event-Typ: ${decisions.event}`);
  lines.push(`  Projekt-Allowlist: ${decisions.project}`);
  lines.push(`  Status-Match: ${decisions.status}`);
  lines.push(`Endgültige Pfadwahl: ${finalPath}`);
  lines.push(SEPARATOR_BOTTOM);

  console.warn(lines.join('\n'));
}

/**
 * Prints the single-line summary that is shown for every webhook request
 * regardless of WEBHOOK_DEBUG.
 *
 * @param {Object} args -> Summary fields.
 * @param {string|null} args.issueKey -> Issue key.
 * @param {string|null} args.newStatus -> Status name.
 * @param {string|null} args.projectKey -> Project key.
 * @param {string} args.finalPath -> Routing outcome label.
 * @returns {void}
 */
function printOneLineSummary({ issueKey, newStatus, projectKey, finalPath }) {
  const parts = [
    `[webhook] ${nowIso()}`,
    `issue=${issueKey ?? '?'}`,
    `status=${newStatus ?? '?'}`,
    `project=${projectKey ?? '?'}`,
    `-> ${finalPath}`,
  ];
  console.warn(parts.join(' '));
}

/**
 * Verifies the GitHub webhook signature (X-Hub-Signature-256) against the
 * configured secret using a timing-safe comparison over the raw request body.
 * Only called when a secret is configured.
 *
 * @param {import('express').Request} req -> Request (expects req.rawBody).
 * @param {string} secret -> Configured webhook secret (non-empty).
 * @returns {boolean} -> True when the signature matches.
 */
function isGithubSignatureValid(req, secret) {
  if (!req.rawBody) return false;
  const provided = req.get('X-Hub-Signature-256') || '';
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Builds the Express router that handles Jira webhooks.
 *
 * The handler responds with 200 immediately and processes the workflow
 * asynchronously, because Jira applies a short timeout.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.workflowService -> Workflow service instance.
 * @param {Object} deps.settingsService -> Settings store (Jira config source).
 * @param {Object} deps.versionService -> Version service (GitHub release/push handling).
 * @param {Object} deps.config -> App config (webhookDebug flag).
 * @returns {import('express').Router} -> The configured router.
 */
function createWebhookRouter({ workflowService, settingsService, versionService, config }) {
  log('createWebhookRouter called');
  const router = express.Router();

  const webhookLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 100 });

  // GitHub webhook for the update check. Accepts release + push events and (when
  // a secret is configured) verifies the X-Hub-Signature-256 HMAC. Without a
  // secret it accepts the request (same PoC posture as the Jira webhook above).
  router.post('/github', (req, res) => {
    log('POST /webhook/github received');

    const secret = settingsService.getUpdateCheckConfig().githubWebhookSecret;
    if (secret && !isGithubSignatureValid(req, secret)) {
      res.status(401).json({ error: 'Ungültige Signatur' });
      return;
    }

    const event = req.get('X-GitHub-Event') || '';

    if (event === 'ping') {
      res.status(200).json({ ok: true, pong: true });
      return;
    }

    if (event === 'release') {
      if (req.body && req.body.action === 'published') {
        versionService.checkForUpdates({ force: true }).catch((err) => {
          console.error('[webhook] github release check failed:', err.message);
        });
        res.status(202).json({ ok: true });
        return;
      }
      res.status(202).json({ ok: true, ignored: true });
      return;
    }

    if (event === 'push') {
      versionService.notifyPush(req.body || {});
      res.status(202).json({ ok: true });
      return;
    }

    res.status(202).json({ ok: true, ignored: true });
  });

  router.post('/jira', webhookLimiter, (req, res) => {
    log('POST /webhook/jira received');

    const payload = req.body || {};
    const issueKey = payload?.issue?.key || null;
    const webhookEvent = payload?.webhookEvent || null;
    const newStatus = extractStatusTransition(payload);
    const projectKey = payload?.issue?.fields?.project?.key || null;
    const reporterAccountId = payload?.issue?.fields?.reporter?.accountId || null;

    // Global pause switch (Danger Zone). When disabled, no webhook is processed:
    // we acknowledge with 202 so Jira does not retry, and log a single summary
    // line. Checked before reading the Jira config so a paused bot does no work.
    if (!settingsService.getWebhookIngestEnabled()) {
      const finalPath = 'ignoriert (Webhook-Verarbeitung pausiert)';
      res.status(202).json({ ok: true, ignored: true, paused: true });

      printOneLineSummary({ issueKey, newStatus, projectKey, finalPath });
      if (config.webhookDebug) {
        printDebugBlock({
          req,
          payload,
          config,
          issueKey,
          newStatus,
          projectKey,
          reporterAccountId,
          decisions: {
            secret: 'übersprungen (pausiert)',
            event: 'übersprungen (pausiert)',
            project: 'übersprungen (pausiert)',
            status: 'übersprungen (pausiert)',
          },
          finalPath,
        });
      }
      return;
    }

    // Jira config is read fresh on every webhook so admin changes (project
    // keys, status lists, secret) take effect without a restart.
    const jiraCfg = settingsService.getJiraConfig();

    const decisions = {
      secret: '',
      event: '',
      project: '',
      status: '',
    };

    const secretConfigured = Boolean(jiraCfg.webhookSecret);
    const secretOk = isWebhookAuthorized(req, jiraCfg.webhookSecret);
    decisions.secret = secretConfigured
      ? `aktiv (erwartet=${maskSecret(jiraCfg.webhookSecret)}) -> ${secretOk ? 'OK' : 'ABGELEHNT (Secret falsch oder fehlt)'}`
      : 'aus -> OK (kein Secret konfiguriert)';

    if (!secretOk) {
      decisions.event = 'übersprungen';
      decisions.project = 'übersprungen';
      decisions.status = 'übersprungen';
      const finalPath = 'ignoriert (Secret abgelehnt)';

      res.status(401).json({ ok: false, error: 'Ungültiges Secret' });

      printOneLineSummary({ issueKey, newStatus, projectKey, finalPath });
      if (config.webhookDebug) {
        printDebugBlock({
          req,
          payload,
          config,
          issueKey,
          newStatus,
          projectKey,
          reporterAccountId,
          decisions,
          finalPath,
        });
      }
      return;
    }

    // Hard filter on webhookEvent BEFORE doing any further work. Jira fires
    // comment_created, comment_updated, comment_deleted, worklog_*, attachment_*
    // and many more for every change on a ticket. Our bot itself writes
    // comments via the Jira REST API, so those events would trigger the
    // pipeline again and again. We only ever care about real issue updates.
    const eventOk = !webhookEvent || STATUS_CHANGE_EVENTS.has(webhookEvent);
    decisions.event = `webhookEvent=${webhookEvent ?? '(fehlt)'} -> ${eventOk ? 'OK' : 'IGNORIERT (kein issue_updated/issue_generic)'}`;

    if (!eventOk) {
      decisions.project = 'übersprungen';
      decisions.status = 'übersprungen';
      const finalPath = 'ignoriert (Event-Typ nicht relevant)';
      res.status(202).json({ ok: true, ignored: true });

      printOneLineSummary({ issueKey, newStatus, projectKey, finalPath });
      if (config.webhookDebug) {
        printDebugBlock({
          req,
          payload,
          config,
          issueKey,
          newStatus,
          projectKey,
          reporterAccountId,
          decisions,
          finalPath,
        });
      }
      return;
    }

    const allowedKeys = jiraCfg.projectKeys;
    const projectOk = isAllowedProject(payload, allowedKeys);
    decisions.project = `erlaubt=[${allowedKeys.join(', ')}], eingehend=${projectKey ?? '(fehlt)'} -> ${projectOk ? 'OK' : 'IGNORIERT (Projekt nicht in Allowlist)'}`;

    if (!issueKey || !newStatus) {
      decisions.status = `eingehend=${newStatus ?? '(keine Status-Transition im Changelog)'} -> IGNORIERT (kein Status-Wechsel oder issue.key fehlt)`;
      const finalPath = 'ignoriert (keine Status-Transition)';
      res.status(202).json({ ok: true, ignored: true });

      printOneLineSummary({ issueKey, newStatus, projectKey, finalPath });
      if (config.webhookDebug) {
        printDebugBlock({
          req,
          payload,
          config,
          issueKey,
          newStatus,
          projectKey,
          reporterAccountId,
          decisions,
          finalPath,
        });
      }
      return;
    }

    if (!projectOk) {
      decisions.status = 'übersprungen';
      const finalPath = 'ignoriert (Projekt nicht in Allowlist)';
      res.status(202).json({ ok: true, ignored: true });

      printOneLineSummary({ issueKey, newStatus, projectKey, finalPath });
      if (config.webhookDebug) {
        printDebugBlock({
          req,
          payload,
          config,
          issueKey,
          newStatus,
          projectKey,
          reporterAccountId,
          decisions,
          finalPath,
        });
      }
      return;
    }

    const isDone = matchesAnyStatus(newStatus, jiraCfg.doneStatuses);
    const isRework = matchesAnyStatus(newStatus, jiraCfg.reworkStatuses);

    let statusResult;
    let finalPath;
    if (isDone) {
      statusResult = 'DONE';
      finalPath = 'handleIssueDone';
    } else if (isRework) {
      statusResult = 'REWORK';
      finalPath = 'handleIssueRework';
    } else {
      statusResult = 'IGNORIERT';
      finalPath = 'ignoriert (Status nicht in Trigger-Liste)';
    }
    decisions.status = `done=[${jiraCfg.doneStatuses.join(', ')}], rework=[${jiraCfg.reworkStatuses.join(', ')}], eingehend=${newStatus} -> ${statusResult}`;

    // Respond first, dispatch after.
    res.status(200).json({ ok: true, issueKey, newStatus });

    printOneLineSummary({ issueKey, newStatus, projectKey, finalPath });
    if (config.webhookDebug) {
      printDebugBlock({
        req,
        payload,
        config,
        issueKey,
        newStatus,
        projectKey,
        reporterAccountId,
        decisions,
        finalPath,
      });
    }

    if (isDone) {
      workflowService.handleIssueDone(issueKey, payload.issue).catch((err) => {
        console.error('[webhook] handleIssueDone failed:', err.message);
      });
      return;
    }

    if (isRework) {
      workflowService.handleIssueRework(issueKey, payload.issue).catch((err) => {
        console.error('[webhook] handleIssueRework failed:', err.message);
      });
      return;
    }

    log('webhook ignored: status not in trigger list: %o', { issueKey, newStatus });
  });

  return router;
}

module.exports = { createWebhookRouter };
