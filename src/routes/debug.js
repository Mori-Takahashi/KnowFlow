'use strict';

const express = require('express');
const debug = require('debug');

const debugState = require('../services/debugState');
const socketService = require('../services/socketService');

const log = debug('knowflow:routes:debug');

const HEALTH_SERVICES = ['knowflow', 'openwebui', 'jira'];
const HEALTH_STATUSES = ['up', 'warn', 'down'];
const SPEEDS = ['fast', 'normal', 'slow'];

/**
 * Builds the debug API router. This router is only mounted when UI_DEBUG=true,
 * so its mere presence (the /status endpoint answering 200) is what tells the
 * WebUI that debug controls may be shown.
 *
 * Endpoints let a presenter:
 *   - simulate a ticket transfer that runs slowly or aborts at a chosen step
 *   - force a service to appear down/warn in the health dashboard
 * without touching the real Jira or Open WebUI APIs.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.workflowService -> Workflow service (for simulateTransfer).
 * @returns {import('express').Router} -> Configured router.
 */
function createDebugRouter({ workflowService }) {
  log('createDebugRouter called');
  const router = express.Router();

  router.get('/status', (_req, res) => {
    log('GET /api/debug/status');
    res.json({ enabled: true, healthOverrides: debugState.getHealthOverrides() });
  });

  router.post('/simulate', (req, res) => {
    log('POST /api/debug/simulate %o', req.body);
    const body = req.body || {};

    const speed = SPEEDS.includes(body.speed) ? body.speed : 'normal';

    const rawStep = Number(body.failAtStep);
    const failAtStep = rawStep === 0 || rawStep === 1 || rawStep === 2 ? rawStep : null;

    const jiraId =
      typeof body.jiraId === 'string' && body.jiraId.trim() ? body.jiraId.trim() : null;
    const errorMessage =
      typeof body.errorMessage === 'string' && body.errorMessage.trim()
        ? body.errorMessage.trim()
        : null;

    // Respond immediately; the simulation runs asynchronously and streams its
    // progress to the dashboard via Socket.IO, exactly like a real pipeline.
    res.status(202).json({ ok: true, started: true, speed, failAtStep });

    workflowService
      .simulateTransfer({ jiraId, speed, failAtStep, errorMessage })
      .catch((err) => {
        console.error('[debug] simulateTransfer failed:', err.message);
      });
  });

  router.post('/health-override', (req, res) => {
    log('POST /api/debug/health-override %o', req.body);
    const body = req.body || {};
    const service = body.service;
    const status = body.status || null;

    if (!HEALTH_SERVICES.includes(service)) {
      return res.status(400).json({ error: `Unbekannter Service: ${service}` });
    }
    if (status && !HEALTH_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Unbekannter Status: ${status}` });
    }

    debugState.setHealthOverride(service, status);
    debugState.invalidate();
    socketService.emitHealthUpdate({ via: 'debug', service, status });

    return res.json({ ok: true, healthOverrides: debugState.getHealthOverrides() });
  });

  router.post('/reset', (_req, res) => {
    log('POST /api/debug/reset');
    debugState.clearHealthOverrides();
    debugState.invalidate();
    socketService.emitHealthUpdate({ via: 'debug', reset: true });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createDebugRouter };
