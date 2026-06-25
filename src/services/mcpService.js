'use strict';

const fs = require('fs');
const debug = require('debug');
const { z } = require('zod');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');

const queries = require('../db/queries');
const embeddingService = require('./embeddingService');
const socketService = require('./socketService');
const { ACTIVITY_KIND } = require('../constants');

const log = debug('knowflow:mcpService');

// Number of characters of context shown around a search match in a snippet.
const SNIPPET_RADIUS = 200;

/**
 * Reports whether a MIME type denotes an image, so attachments can be rendered
 * inline and surfaced as image links instead of generic downloads.
 *
 * @param {string|null} mimeType -> Attachment MIME type.
 * @returns {boolean} -> True for image/* types.
 */
function isImageMime(mimeType) {
  return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');
}

/**
 * Builds a short snippet around the first occurrence of a query term within a
 * markdown body. Falls back to the leading characters when no match is found.
 *
 * @param {string} markdown -> Full markdown body.
 * @param {string} query -> Search term.
 * @returns {string} -> A trimmed snippet of at most ~2*SNIPPET_RADIUS chars.
 */
function buildSnippet(markdown, query) {
  const body = String(markdown || '');
  const idx = body.toLowerCase().indexOf(String(query || '').toLowerCase());
  if (idx < 0) {
    return body.slice(0, SNIPPET_RADIUS).trim();
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(body.length, idx + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

/**
 * Merges semantic (vector) and keyword search results into a single de-duplicated
 * list, capped at `limit`. Vector hits are listed first (best semantic match on
 * top); keyword hits then fill the remaining slots, which guarantees exact
 * matches (e.g. a Jira id) still surface even when RAG is active, and provides a
 * graceful fallback when the embedding service is unavailable.
 *
 * @param {Object[]} vectorRows -> Semantic results (ordered by score), may be empty.
 * @param {Object[]} keywordRows -> Keyword (LIKE) results.
 * @param {number} limit -> Maximum number of merged rows.
 * @returns {Object[]} -> Merged rows.
 */
function mergeResults(vectorRows, keywordRows, limit) {
  const out = [];
  const seen = new Set();
  for (const row of [...vectorRows, ...keywordRows]) {
    if (seen.has(row.jira_id)) continue;
    seen.add(row.jira_id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Factory: returns the MCP service. The MCP servers expose ticket knowledge
 * (markdown), attachments and inline images to external MCP clients, scoped per
 * connection.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.config -> App config (publicBaseUrl).
 * @param {Object} deps.attachmentService -> Attachment service (resolveLocalPath).
 * @param {Object} deps.jiraService -> Jira service (comments + transitions) for write-back tools.
 * @param {Object} deps.settingsService -> Settings service (rework statuses for transitions).
 * @returns {Object} -> Service with listConnectionsWithStats, buildServer.
 */
function createMcpService({ config, attachmentService, jiraService, settingsService }) {
  log('createMcpService called');

  /**
   * Builds the public MCP endpoint URL for a connection id.
   *
   * @param {string} id -> Connection id (slug).
   * @returns {string} -> Endpoint URL.
   */
  function endpointFor(id) {
    return `${config.publicBaseUrl.replace(/\/$/, '')}/mcp/${encodeURIComponent(id)}`;
  }

  /**
   * Builds the public WebUI deep link for a ticket (mirrors workflowService).
   *
   * @param {string} jiraId -> Issue key.
   * @returns {string} -> Dashboard ticket URL.
   */
  function ticketUrl(jiraId) {
    return `${config.publicBaseUrl.replace(/\/$/, '')}/?ticket=${encodeURIComponent(jiraId)}`;
  }

  /**
   * Logs an activity-feed event and emits it over Socket.IO. Mirrors the helper
   * in workflowService so MCP-triggered actions show up in the live feed.
   *
   * @param {Object} args -> Event fields ({ kind, jiraId, title, detail, source }).
   * @returns {void}
   */
  function recordEvent(args) {
    const event = queries.insertEvent(args);
    socketService.emitActivityNew(event);
  }

  /**
   * Builds the public, directly openable HTTP(S) download URL for a stored
   * attachment. This mirrors the route served at GET
   * /api/attachments/:jiraId/:attachmentId and lets MCP clients link to (or
   * display) images without going through the binary attachment:// resource.
   *
   * @param {string} jiraId -> Issue key.
   * @param {string} attachmentId -> Jira attachment id.
   * @returns {string} -> Absolute download URL.
   */
  function attachmentUrl(jiraId, attachmentId) {
    return `${config.publicBaseUrl.replace(/\/$/, '')}/api/attachments/${encodeURIComponent(jiraId)}/${encodeURIComponent(attachmentId)}`;
  }

  /**
   * Returns all MCP connections enriched with doc/byte stats and the endpoint.
   *
   * @returns {Object[]} -> Connection descriptors.
   */
  function listConnectionsWithStats() {
    log('listConnectionsWithStats called');
    return queries.listMcpConnections().map((conn) => {
      const stats = queries.getMcpConnectionStats(conn);
      return {
        id: conn.id,
        title: conn.title,
        description: conn.description,
        isAll: conn.is_all === 1,
        endpoint: endpointFor(conn.id),
        docCount: stats.count,
        totalBytes: stats.bytes,
      };
    });
  }

  /**
   * Builds a fresh, stateless McpServer for the given connection, registering
   * the knowledge tools and resource templates. A new server is created per
   * request (Streamable HTTP, stateless mode).
   *
   * @param {Object} connection -> mcp_connections row.
   * @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} -> The server.
   */
  function buildServer(connection) {
    log('buildServer called with: %o', { connId: connection?.id });

    const server = new McpServer({
      name: `knowflow-${connection.id}`,
      version: '1.0.0',
    });

    // Tool: search_knowledge
    server.tool(
      'search_knowledge',
      'Durchsucht das Wissen dieser Verbindung nach einem Suchbegriff.',
      { query: z.string(), limit: z.number().optional() },
      async ({ query, limit }) => {
        const max = Math.min(50, limit || 20);
        // Hybrid search: semantic (vector) hits first, keyword hits fill the
        // rest. When RAG is off or the embedding service errors, vectorRows
        // stays empty and this is exactly the previous keyword-only behavior.
        let vectorRows = [];
        if (embeddingService.isEnabled()) {
          try {
            vectorRows = await embeddingService.semanticSearch(connection, query, max);
          } catch (err) {
            log('semantic search failed, falling back to keyword: %s', err.message);
          }
        }
        const keywordRows = queries.searchMcpDocs(connection, query, max);
        const rows = mergeResults(vectorRows, keywordRows, max);
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: `Keine Treffer für "${query}".` }] };
        }
        const content = rows.map((row) => ({
          type: 'text',
          text: `# ${row.jira_id}: ${row.summary}\n${buildSnippet(row.markdown, query)}`,
        }));
        return { content };
      },
    );

    // Tool: list_knowledge
    server.tool(
      'list_knowledge',
      'Listet alle Wissenseinträge dieser Verbindung auf.',
      {},
      async () => {
        const rows = queries.listMcpDocs(connection);
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: 'Keine Wissenseinträge vorhanden.' }] };
        }
        const text = rows
          .map((row) => `- ${row.jira_id}: ${row.summary} (${row.markdown_size} Bytes)`)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      },
    );

    // Tool: read_knowledge
    server.tool(
      'read_knowledge',
      'Liefert das vollständige Markdown eines Wissenseintrags.',
      { jiraId: z.string() },
      async ({ jiraId }) => {
        const doc = queries.getMcpDoc(connection, jiraId);
        if (!doc) {
          return {
            content: [{ type: 'text', text: `Eintrag ${jiraId} ist in dieser Verbindung nicht verfügbar.` }],
          };
        }
        return { content: [{ type: 'text', text: doc.markdown || '' }] };
      },
    );

    // Tool: list_attachments
    server.tool(
      'list_attachments',
      'Listet die Anhänge eines Wissenseintrags (nur im Geltungsbereich der Verbindung).',
      { jiraId: z.string() },
      async ({ jiraId }) => {
        const doc = queries.getMcpDoc(connection, jiraId);
        if (!doc) {
          return {
            content: [{ type: 'text', text: `Eintrag ${jiraId} ist in dieser Verbindung nicht verfügbar.` }],
          };
        }
        const rows = queries.listTicketAttachments(jiraId).filter((r) => r.status === 'stored');
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: `Keine Anhänge für ${jiraId}.` }] };
        }
        const text = rows
          .map((r) => {
            const flag = isImageMime(r.mime_type) ? '🖼 ' : '';
            const url = attachmentUrl(jiraId, r.jira_attachment_id);
            return `- ${flag}${r.filename} (${r.size} Bytes, ${r.mime_type || 'unbekannt'}) -> ${url} (Ressource: attachment://${jiraId}/${r.jira_attachment_id})`;
          })
          .join('\n');
        const hasImages = rows.some((r) => isImageMime(r.mime_type));
        const hint = hasImages
          ? '\n\nTipp: Mit dem Werkzeug "show_images" lassen sich die Bilder dieses Eintrags direkt anzeigen.'
          : '';
        return { content: [{ type: 'text', text: `${text}${hint}` }] };
      },
    );

    // Tool: show_images
    server.tool(
      'show_images',
      'Zeigt die Bilder eines Wissenseintrags an und gibt deren Links aus (nur Bild-Anhänge im Geltungsbereich der Verbindung).',
      { jiraId: z.string() },
      async ({ jiraId }) => {
        const doc = queries.getMcpDoc(connection, jiraId);
        if (!doc) {
          return {
            content: [{ type: 'text', text: `Eintrag ${jiraId} ist in dieser Verbindung nicht verfügbar.` }],
          };
        }
        const images = queries
          .listTicketAttachments(jiraId)
          .filter((r) => r.status === 'stored' && isImageMime(r.mime_type));
        if (images.length === 0) {
          return { content: [{ type: 'text', text: `Keine Bilder für ${jiraId}.` }] };
        }
        const content = [];
        for (const r of images) {
          const url = attachmentUrl(jiraId, r.jira_attachment_id);
          content.push({ type: 'text', text: `${r.filename} -> ${url}` });
          try {
            const absPath = attachmentService.resolveLocalPath(r);
            const data = fs.readFileSync(absPath);
            content.push({
              type: 'image',
              data: data.toString('base64'),
              mimeType: r.mime_type || 'application/octet-stream',
            });
          } catch (err) {
            content.push({
              type: 'text',
              text: `(Bild ${r.filename} konnte nicht geladen werden: ${err.message})`,
            });
          }
        }
        return { content };
      },
    );

    // Tool: report_inaccuracy (write-back) — only when enabled for this connection.
    if (connection.allow_feedback === 1) {
      server.tool(
        'report_inaccuracy',
        'Meldet einen Fehler/eine Ungenauigkeit in einem Wissensartikel an das zugehörige Jira-Ticket. '
          + 'WICHTIG: Frage den Nutzer zuerst, WAS GENAU nicht stimmt (und – falls bekannt – die richtige Angabe), '
          + 'bevor du dieses Werkzeug aufrufst. KnowFlow schreibt daraufhin einen Kommentar an das Ticket und '
          + 'verschiebt es ggf. in einen Überarbeitungs-Status.',
        {
          jiraId: z.string(),
          was_ist_falsch: z.string(),
          korrektur: z.string().optional(),
        },
        async ({ jiraId, was_ist_falsch, korrektur }) => {
          // Scope guard: only tickets visible through this connection may be flagged.
          const doc = queries.getMcpDoc(connection, jiraId);
          if (!doc) {
            return {
              content: [{ type: 'text', text: `Eintrag ${jiraId} ist in dieser Verbindung nicht verfügbar.` }],
            };
          }
          if (!was_ist_falsch || !was_ist_falsch.trim()) {
            return {
              content: [{
                type: 'text',
                text: 'Bitte zuerst beim Nutzer erfragen, was genau nicht stimmt, und es als "was_ist_falsch" übergeben.',
              }],
            };
          }

          const ticket = queries.getTicket(jiraId);
          const accountId = ticket?.reporter_account_id ?? null;

          try {
            await jiraService.addInaccuracyComment(
              jiraId,
              accountId,
              { whatIsWrong: was_ist_falsch, correction: korrektur || '' },
              { label: 'Ticket im KnowFlow Dashboard öffnen', url: ticketUrl(jiraId) },
            );
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `Der Jira-Kommentar konnte nicht geschrieben werden: ${err.message}`,
              }],
            };
          }

          // Optional: move the ticket into a configured rework status. A failure
          // here must not undo the comment, so it is reported but not thrown.
          let moveNote = '';
          const reworkStatuses = (settingsService.getJiraConfig().reworkStatuses || []).filter(Boolean);
          if (reworkStatuses.length > 0) {
            try {
              const transitions = await jiraService.getIssueTransitions(jiraId);
              const wanted = reworkStatuses.map((s) => s.toLowerCase());
              const match = transitions.find((t) => wanted.includes(String(t.to?.name || '').toLowerCase()));
              if (match) {
                await jiraService.transitionIssue(jiraId, match.id);
                moveNote = ` Das Ticket wurde nach „${match.to.name}" verschoben.`;
              } else {
                moveNote = ' Ein passender Überarbeitungs-Status war nicht verfügbar, das Ticket wurde nicht verschoben.';
              }
            } catch (err) {
              moveNote = ` Hinweis: Das Verschieben des Tickets schlug fehl (${err.message}).`;
            }
          }

          recordEvent({
            kind: ACTIVITY_KIND.WARN,
            jiraId,
            title: 'Ungenauigkeit via MCP gemeldet',
            detail: was_ist_falsch.slice(0, 200),
            source: 'MCP',
          });

          return {
            content: [{
              type: 'text',
              text: `Danke! Die gemeldete Ungenauigkeit wurde als Kommentar an ${jiraId} geschrieben.${moveNote}`,
            }],
          };
        },
      );
    }

    // Resource: knowledge://{jiraId}
    server.resource(
      'knowledge',
      new ResourceTemplate('knowledge://{jiraId}', {
        list: async () => {
          const rows = queries.listMcpDocs(connection);
          return {
            resources: rows.map((row) => ({
              uri: `knowledge://${row.jira_id}`,
              name: `${row.jira_id}: ${row.summary}`,
              mimeType: 'text/markdown',
            })),
          };
        },
      }),
      async (uri, { jiraId }) => {
        const doc = queries.getMcpDoc(connection, jiraId);
        if (!doc) {
          throw new Error(`Eintrag ${jiraId} ist in dieser Verbindung nicht verfügbar.`);
        }
        return {
          contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.markdown || '' }],
        };
      },
    );

    // Resource: attachment://{jiraId}/{attachmentId}
    server.resource(
      'attachment',
      new ResourceTemplate('attachment://{jiraId}/{attachmentId}', { list: undefined }),
      async (uri, { jiraId, attachmentId }) => {
        const doc = queries.getMcpDoc(connection, jiraId);
        if (!doc) {
          throw new Error(`Eintrag ${jiraId} ist in dieser Verbindung nicht verfügbar.`);
        }
        const row = queries.getTicketAttachment(jiraId, attachmentId);
        if (!row || row.status !== 'stored') {
          throw new Error(`Anhang ${attachmentId} ist nicht verfügbar.`);
        }
        const absPath = attachmentService.resolveLocalPath(row);
        const data = fs.readFileSync(absPath);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: row.mime_type || 'application/octet-stream',
              blob: data.toString('base64'),
            },
          ],
        };
      },
    );

    return server;
  }

  return { listConnectionsWithStats, buildServer };
}

module.exports = { createMcpService };
