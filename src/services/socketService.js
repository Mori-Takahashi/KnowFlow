'use strict';

const debug = require('debug');
const { Server } = require('socket.io');

const { SOCKET_EVENTS } = require('../constants');

const log = debug('knowflow:socketService');

let ioInstance = null;

const COOKIE_NAME = 'jb_admin';

/**
 * Minimal cookie-header parser (socket handshakes are not processed by
 * cookie-parser). Returns the value of the named cookie, or null.
 *
 * @param {string|undefined} header -> Raw Cookie header.
 * @param {string} name -> Cookie name to extract.
 * @returns {string|null} -> Decoded value, or null.
 */
function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * Attaches a Socket.IO server to the given HTTP server.
 *
 * @param {import('http').Server} httpServer -> Express HTTP server instance.
 * @param {Object} [deps] -> Optional dependencies enabling the dashboard lock.
 * @param {Object} [deps.authService] -> Auth service (session role resolution).
 * @param {Object} [deps.settingsService] -> Settings store (access config).
 * @returns {import('socket.io').Server} -> The Socket.IO server.
 */
function attach(httpServer, { authService, settingsService } = {}) {
  log('attach called');
  ioInstance = new Server(httpServer, {
    cors: { origin: '*' },
  });

  // When the dashboard is locked, only authenticated sessions may receive the
  // live event stream (which carries ticket/activity data).
  if (authService && settingsService) {
    ioInstance.use((socket, next) => {
      if (!settingsService.getAccessConfig().dashboardLocked) {
        next();
        return;
      }
      const token = readCookie(socket.handshake.headers.cookie, COOKIE_NAME);
      if (authService.getSessionRole(token)) {
        next();
        return;
      }
      next(new Error('unauthorized'));
    });
  }

  ioInstance.on('connection', (socket) => {
    log('client connected: %o', { id: socket.id });
    socket.on('disconnect', () => {
      log('client disconnected: %o', { id: socket.id });
    });
  });
  return ioInstance;
}

/**
 * Emits an event to all connected clients. No-op if Socket.IO is not attached.
 *
 * @param {string} event -> Event name from SOCKET_EVENTS.
 * @param {Object} payload -> JSON-serializable payload.
 * @returns {void}
 */
function emit(event, payload) {
  log('emit called with: %o', { event });
  if (!ioInstance) {
    console.warn('[socketService] Emit aufgerufen, bevor Socket.IO bereit war.');
    return;
  }
  ioInstance.emit(event, payload);
}

/**
 * Convenience emitter for a workflow update.
 *
 * @param {Object} payload -> Workflow state payload.
 * @returns {void}
 */
function emitWorkflowUpdate(payload) {
  emit(SOCKET_EVENTS.WORKFLOW_UPDATE, payload);
}

/**
 * Convenience emitter for a new activity event.
 *
 * @param {Object} payload -> Activity event payload.
 * @returns {void}
 */
function emitActivityNew(payload) {
  emit(SOCKET_EVENTS.ACTIVITY_NEW, payload);
}

/**
 * Convenience emitter for ticket status changes.
 *
 * @param {Object} payload -> Ticket status payload.
 * @returns {void}
 */
function emitTicketStatus(payload) {
  emit(SOCKET_EVENTS.TICKET_STATUS, payload);
}

/**
 * Convenience emitter for service health changes.
 *
 * @param {Object} payload -> Health payload.
 * @returns {void}
 */
function emitHealthUpdate(payload) {
  emit(SOCKET_EVENTS.HEALTH_UPDATE, payload);
}

/**
 * Convenience emitter for RAG reindex progress.
 *
 * @param {Object} payload -> Reindex progress payload.
 * @returns {void}
 */
function emitRagProgress(payload) {
  emit(SOCKET_EVENTS.RAG_PROGRESS, payload);
}

module.exports = {
  attach,
  emit,
  emitWorkflowUpdate,
  emitActivityNew,
  emitTicketStatus,
  emitHealthUpdate,
  emitRagProgress,
};
