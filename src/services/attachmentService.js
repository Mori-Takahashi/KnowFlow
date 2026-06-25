'use strict';

const fs = require('fs');
const path = require('path');
const debug = require('debug');

const queries = require('../db/queries');

const log = debug('knowflow:attachmentService');

// Attachment record statuses persisted in ticket_attachments.status.
const STATUS = Object.freeze({
  STORED: 'stored',
  SKIPPED_TOO_LARGE: 'skipped_too_large',
  ERROR: 'error',
});

/**
 * Sanitizes a filename so it is safe to use as a path segment: strips path
 * separators and control characters, collapses whitespace, and falls back to a
 * generic name when the result would be empty.
 *
 * @param {string} filename -> Raw filename from Jira.
 * @returns {string} -> Safe filename.
 */
function sanitizeFilename(filename) {
  const raw = String(filename || '').trim();
  // Remove any directory parts, then strip separators and control chars.
  const base = raw.split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f<>:"\\/|?*]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'anhang';
}

/**
 * Factory: returns the attachment service bound to its dependencies. The service
 * mirrors a Jira issue's attachments into local storage and the
 * ticket_attachments table, so the bot can serve them and reference them in the
 * generated markdown without re-hitting Jira on every request.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.jiraService -> Jira service (downloadAttachment).
 * @param {Object} deps.config -> App config (attachmentsDir, attachmentMaxBytes).
 * @returns {Object} -> Service with syncAttachments, resolveLocalPath.
 */
function createAttachmentService({ jiraService, config }) {
  log('createAttachmentService called');

  const baseDir = config.attachmentsDir;
  const maxBytes = config.attachmentMaxBytes;

  /**
   * Deletes the entire attachments directory recursively and recreates it empty.
   * Used by the Danger Zone global wipe so no orphaned files remain after all
   * tickets are removed. Best effort: filesystem errors are logged as warnings
   * and never thrown, so the surrounding wipe can still complete.
   *
   * @returns {void}
   */
  function wipeAllFiles() {
    log('wipeAllFiles called with: %o', { baseDir });
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.mkdirSync(baseDir, { recursive: true });
    } catch (err) {
      console.warn('[attachmentService] wipeAllFiles fehlgeschlagen:', err.message);
    }
  }

  /**
   * Resolves the absolute on-disk path for a stored attachment row, guarding
   * against path traversal: the resolved path must stay inside attachmentsDir.
   *
   * @param {Object} row -> ticket_attachments row (needs local_path).
   * @returns {string} -> Absolute, contained file path.
   * @throws {Error} -> If the row has no local_path or the path escapes baseDir.
   */
  function resolveLocalPath(row) {
    if (!row || !row.local_path) {
      throw new Error('Anhang hat keinen lokalen Pfad.');
    }
    const abs = path.resolve(baseDir, row.local_path);
    const containedRoot = path.resolve(baseDir) + path.sep;
    if (abs !== path.resolve(baseDir) && !abs.startsWith(containedRoot)) {
      throw new Error('Ungültiger Anhang-Pfad (Path-Traversal verhindert).');
    }
    return abs;
  }

  /**
   * Synchronizes the attachments of a Jira issue into local storage and the DB.
   *
   * For each attachment on the issue: skips re-download when an unchanged stored
   * copy already exists; records oversized attachments as 'skipped_too_large';
   * otherwise downloads and stores the file. Attachments that disappeared from
   * the issue are pruned from disk and the DB.
   *
   * @param {string} issueKey -> Issue key (used as a subdirectory).
   * @param {Object} issue -> Jira issue payload (issue.fields.attachment).
   * @returns {Promise<{attachments: Object[], skipped: Object[], errors: Object[]}>}
   *   -> Stored rows, skipped descriptors, and per-file error descriptors.
   */
  async function syncAttachments(issueKey, issue) {
    log('syncAttachments called with: %o', { issueKey });

    const jiraAttachments = Array.isArray(issue?.fields?.attachment)
      ? issue.fields.attachment
      : [];

    const existingRows = queries.listTicketAttachments(issueKey);
    const existingById = new Map(existingRows.map((r) => [r.jira_attachment_id, r]));
    const seenIds = new Set();

    const stored = [];
    const skipped = [];
    const errors = [];

    const issueDir = path.join(baseDir, sanitizeFilename(issueKey));

    for (const att of jiraAttachments) {
      const attachmentId = String(att.id);
      seenIds.add(attachmentId);
      const filename = att.filename || `${attachmentId}`;
      const mimeType = att.mimeType || null;
      const size = Number.isFinite(att.size) ? att.size : 0;
      const jiraCreated = att.created || null;
      const contentUrl = att.content;

      const prior = existingById.get(attachmentId);

      // Dedup: unchanged + already stored + file still present on disk.
      if (
        prior
        && prior.status === STATUS.STORED
        && prior.size === size
        && prior.jira_created === jiraCreated
        && prior.local_path
      ) {
        try {
          const abs = path.resolve(baseDir, prior.local_path);
          if (fs.existsSync(abs)) {
            stored.push(prior);
            continue;
          }
        } catch (_err) {
          // Fall through to re-download below.
        }
      }

      if (size > maxBytes) {
        queries.upsertTicketAttachment({
          jiraId: issueKey,
          jiraAttachmentId: attachmentId,
          filename,
          mimeType,
          size,
          jiraCreated,
          localPath: null,
          status: STATUS.SKIPPED_TOO_LARGE,
        });
        skipped.push({ attachmentId, filename, size });
        continue;
      }

      try {
        if (!contentUrl) {
          throw new Error('Anhang hat keine Content-URL.');
        }
        const data = await jiraService.downloadAttachment(contentUrl, maxBytes);
        if (!fs.existsSync(issueDir)) {
          fs.mkdirSync(issueDir, { recursive: true });
        }
        const safeName = `${attachmentId}_${sanitizeFilename(filename)}`;
        const absPath = path.join(issueDir, safeName);
        fs.writeFileSync(absPath, data);
        const relPath = path.relative(baseDir, absPath);
        queries.upsertTicketAttachment({
          jiraId: issueKey,
          jiraAttachmentId: attachmentId,
          filename,
          mimeType,
          size: size || data.length,
          jiraCreated,
          localPath: relPath,
          status: STATUS.STORED,
        });
        stored.push(queries.getTicketAttachment(issueKey, attachmentId));
      } catch (err) {
        console.error(`[attachmentService] download failed for ${issueKey}/${attachmentId}:`, err.message);
        queries.upsertTicketAttachment({
          jiraId: issueKey,
          jiraAttachmentId: attachmentId,
          filename,
          mimeType,
          size,
          jiraCreated,
          localPath: null,
          status: STATUS.ERROR,
        });
        errors.push({ attachmentId, filename, error: err.message });
      }
    }

    // Prune attachments that no longer exist on the issue.
    for (const row of existingRows) {
      if (seenIds.has(row.jira_attachment_id)) continue;
      try {
        if (row.local_path) {
          const abs = path.resolve(baseDir, row.local_path);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        }
      } catch (err) {
        console.warn(`[attachmentService] prune unlink failed for ${row.local_path}:`, err.message);
      }
      queries.deleteTicketAttachment(issueKey, row.jira_attachment_id);
    }

    log('syncAttachments result: %o', {
      issueKey,
      stored: stored.length,
      skipped: skipped.length,
      errors: errors.length,
    });
    return { attachments: stored, skipped, errors };
  }

  return { syncAttachments, resolveLocalPath, wipeAllFiles };
}

module.exports = { createAttachmentService, sanitizeFilename };
