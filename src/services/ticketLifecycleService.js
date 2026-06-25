'use strict';

const debug = require('debug');

const queries = require('../db/queries');
const socketService = require('./socketService');
const { TICKET_LIFECYCLE, ACTIVITY_KIND } = require('../constants');

const log = debug('knowflow:ticketLifecycleService');

/**
 * Logs an activity event in the DB and emits the corresponding Socket.IO event.
 *
 * @param {Object} args -> Event fields ({ kind, jiraId, title, detail, source }).
 * @returns {Object} -> The inserted event row.
 */
function recordEvent(args) {
  const event = queries.insertEvent(args);
  socketService.emitActivityNew(event);
  return event;
}

/**
 * Emits the current ticket status so the dashboard refreshes after a lifecycle
 * change.
 *
 * @param {Object} ticket -> Ticket row.
 * @returns {void}
 */
function broadcastTicket(ticket) {
  socketService.emitTicketStatus({
    jiraId: ticket.jira_id,
    overallStatus: ticket.overall_status,
    jiraStatus: ticket.jira_status,
  });
}

/**
 * Factory: returns the ticket lifecycle service. It marks tickets obsolete or
 * deleted (removing their knowledge from every OpenWebUI target) or reactivates
 * them. Reactivation only flips the lifecycle flag; the caller (admin route)
 * triggers a fresh pipeline run.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.openwebuiService -> OpenWebUI service (removeFromKnowledge, deleteFile).
 * @param {Object} deps.settingsService -> Settings store (target lookup).
 * @param {Object} deps.attachmentService -> Attachment service (wipeAllFiles on global wipe).
 * @returns {Object} -> Service with setLifecycle, wipeAllTickets.
 */
function createTicketLifecycleService({ openwebuiService, settingsService, attachmentService }) {
  log('createTicketLifecycleService called');

  /**
   * Removes a ticket's uploaded knowledge from every OpenWebUI target it was
   * pushed to. Per-target failures are logged as warn events and do not abort
   * the operation. Clears the local upload records afterwards.
   *
   * @param {string} jiraId -> Issue key.
   * @returns {Promise<void>}
   */
  async function removeKnowledgeUploads(jiraId) {
    const uploads = queries.listTicketUploads(jiraId);
    for (const upload of uploads) {
      if (!upload.owui_uuid) continue;
      const target = settingsService.getTarget(upload.target_id);
      try {
        await openwebuiService.removeFromKnowledge(upload.owui_uuid, target);
        await openwebuiService.deleteFile(upload.owui_uuid, target);
      } catch (err) {
        console.error(`[ticketLifecycleService] removal failed for ${jiraId}/${upload.target_id}:`, err.message);
        recordEvent({
          kind: ACTIVITY_KIND.WARN,
          jiraId,
          title: `Wissen konnte aus Ziel nicht entfernt werden (${target?.name || upload.target_id})`,
          detail: err.message,
          source: 'WebUI',
        });
      }
    }
    queries.deleteTicketUploads(jiraId);
    queries.setTicketOpenWebUiUuid(jiraId, null);
  }

  /**
   * Sets a ticket's lifecycle. For 'obsolete' and 'deleted', the ticket's
   * knowledge is removed from all OpenWebUI targets first. For 'active', only
   * the flag is flipped (the admin route re-runs the pipeline).
   *
   * @param {string} jiraId -> Issue key.
   * @param {string} lifecycle -> One of TICKET_LIFECYCLE values.
   * @returns {Promise<void>}
   * @throws {Error} -> If the ticket does not exist or the lifecycle is invalid.
   */
  async function setLifecycle(jiraId, lifecycle) {
    log('setLifecycle called with: %o', { jiraId, lifecycle });
    const ticket = queries.getTicket(jiraId);
    if (!ticket) {
      throw new Error(`Ticket ${jiraId} wurde nicht gefunden.`);
    }
    const valid = Object.values(TICKET_LIFECYCLE);
    if (!valid.includes(lifecycle)) {
      throw new Error(`Ungültiger Lebenszyklus: ${lifecycle}`);
    }

    if (lifecycle === TICKET_LIFECYCLE.OBSOLETE || lifecycle === TICKET_LIFECYCLE.DELETED) {
      await removeKnowledgeUploads(jiraId);
      queries.setTicketLifecycle(jiraId, lifecycle);
      const isDelete = lifecycle === TICKET_LIFECYCLE.DELETED;
      recordEvent({
        kind: ACTIVITY_KIND.WARN,
        jiraId,
        title: isDelete ? `${jiraId} gelöscht` : `${jiraId} als veraltet markiert`,
        detail: 'Wissen aus allen Wissensbasen entfernt.',
        source: 'WebUI',
      });
    } else {
      queries.setTicketLifecycle(jiraId, TICKET_LIFECYCLE.ACTIVE);
      recordEvent({
        kind: ACTIVITY_KIND.INFO,
        jiraId,
        title: `${jiraId} reaktiviert`,
        detail: 'Wissen wird neu aufgebaut.',
        source: 'WebUI',
      });
    }

    const updated = queries.getTicket(jiraId);
    if (updated) broadcastTicket(updated);
  }

  /**
   * Removes every ticket and all of its associated knowledge (Danger Zone). For
   * each ticket that has uploads, its knowledge is first removed from every
   * OpenWebUI target (best effort, per-target failures are recorded as warn
   * events by removeKnowledgeUploads). Afterwards all ticket-related rows are
   * dropped in one transaction and the local attachments directory is wiped.
   *
   * @returns {Promise<{deleted: number}>} -> Number of deleted ticket rows.
   */
  async function wipeAllTickets() {
    log('wipeAllTickets called');

    // Remove knowledge from OpenWebUI for every ticket that has uploads. We
    // collect the distinct jira ids from the upload table so tickets without
    // any upload skip the (network) removal step entirely.
    const jiraIds = new Set();
    for (const upload of queries.listAllTicketUploads()) {
      if (upload.jira_id) jiraIds.add(upload.jira_id);
    }
    for (const jiraId of jiraIds) {
      await removeKnowledgeUploads(jiraId);
    }

    const deleted = queries.deleteAllTicketData();
    attachmentService.wipeAllFiles();

    recordEvent({
      kind: ACTIVITY_KIND.WARN,
      jiraId: null,
      title: 'Alle Tickets gelöscht',
      detail: `${deleted} Ticket(s) und zugehöriges Wissen entfernt.`,
      source: 'Admin',
    });

    return { deleted };
  }

  return { setLifecycle, wipeAllTickets };
}

module.exports = { createTicketLifecycleService };
