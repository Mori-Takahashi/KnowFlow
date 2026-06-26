'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const debug = require('debug');
const { v4: uuidv4 } = require('uuid');

const queries = require('../db/queries');

const log = debug('knowflow:routes:openwebuiDummy');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Writes the dummy file's markdown content to disk so the dummy mode behaves
 * consistently whether files are created in-process or via HTTP.
 *
 * @param {string} dummyDir -> Absolute directory.
 * @param {string} uuid -> File UUID.
 * @param {string} content -> Markdown content.
 * @returns {void}
 */
function writeToDisk(dummyDir, uuid, content) {
  if (!fs.existsSync(dummyDir)) fs.mkdirSync(dummyDir, { recursive: true });
  fs.writeFileSync(path.join(dummyDir, `${uuid}.md`), content, 'utf8');
}

/**
 * Builds a router that mimics the Open WebUI endpoints we use:
 *
 *   POST /openwebui-dummy/api/v1/files/
 *   POST /openwebui-dummy/api/v1/files/:id/data/content/update
 *   POST /openwebui-dummy/api/v1/knowledge/:knowledgeId/file/add
 *
 * The real openwebuiService.js implements its dummy mode by writing directly to
 * the local DB, so these HTTP endpoints are provided as a stand-in that can be
 * curled manually to inspect / test the dummy storage. They are mounted under
 * /openwebui-dummy.
 *
 * @param {string} dummyStorageDir -> Absolute path used for on-disk mirrors.
 * @returns {import('express').Router} -> The router.
 */
function createOpenWebUiDummyRouter(dummyStorageDir) {
  log('createOpenWebUiDummyRouter called');
  const router = express.Router();

  router.post('/api/v1/files/', (req, res) => {
    log('POST dummy /api/v1/files/');
    try {
      const content = (req.body && (req.body.content || req.body.markdown)) || '';
      const jiraId = (req.body && req.body.jiraId) || 'UNKNOWN';
      if (!content) {
        return res.status(400).json({ error: 'content fehlt im Body' });
      }
      const id = uuidv4();
      queries.insertDummyFile({ uuid: id, jiraId, content });
      if (dummyStorageDir) writeToDisk(dummyStorageDir, id, content);
      res.json({ id });
    } catch (err) {
      console.error('[openwebuiDummy] upload failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/v1/files/:id/data/content/update', (req, res) => {
    log('POST dummy /api/v1/files/:id/data/content/update %o', { id: req.params.id });
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Ungültige Datei-ID' });
    }
    try {
      const content = (req.body && req.body.content) || '';
      const ok = queries.updateDummyFileContent(req.params.id, content);
      if (!ok) return res.status(404).json({ error: 'Datei nicht gefunden' });
      if (dummyStorageDir) writeToDisk(dummyStorageDir, req.params.id, content);
      // Mirror Open WebUI bug #23787: returns 200 even if reindex fails. We
      // always return success here, matching the real upstream behavior.
      res.json({ id: req.params.id, ok: true });
    } catch (err) {
      console.error('[openwebuiDummy] update failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/v1/knowledge/:knowledgeId/file/add', (req, res) => {
    log('POST dummy /api/v1/knowledge/:knowledgeId/file/add %o', { kb: req.params.knowledgeId });
    try {
      const fileId = (req.body && req.body.file_id) || '';
      if (!fileId) return res.status(400).json({ error: 'file_id fehlt' });
      queries.markDummyFileInKnowledge(fileId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[openwebuiDummy] knowledge/add failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/v1/files/:id', (req, res) => {
    log('GET dummy /api/v1/files/:id %o', { id: req.params.id });
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Ungültige Datei-ID' });
    }
    const row = queries.getDummyFile(req.params.id);
    if (!row) return res.status(404).json({ error: 'Datei nicht gefunden' });
    res.json({
      id: row.uuid,
      jira_id: row.jira_id,
      in_knowledge: !!row.in_knowledge,
      created_at: row.created_at,
      updated_at: row.updated_at,
      content: row.content,
    });
  });

  return router;
}

module.exports = { createOpenWebUiDummyRouter };
