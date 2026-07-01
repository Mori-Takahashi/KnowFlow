'use strict';

const axios = require('axios');
const debug = require('debug');

const queries = require('../db/queries');
const settingsService = require('./settingsService');
const socketService = require('./socketService');
const {
  RAG_MODE,
  DEFAULT_LOCAL_EMBED_MODEL,
  EMBEDDING_STATUS,
  EMBEDDING_MAX_CHARS,
  HTTP_TIMEOUT_MS,
} = require('../constants');

const log = debug('knowflow:embeddingService');

// OpenAI embeddings endpoint. Ollama's endpoint is built from the configured
// base URL since it usually runs locally.
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

// Lazily-instantiated Transformers.js pipeline for the in-process local
// provider. Loading a model is expensive (download on first use + init), so the
// extractor is cached and only rebuilt when the configured model changes.
let localExtractor = { model: null, pipe: null };

// Tracks the background reindex run so the admin dashboard can show progress.
// A single global run is enough: there is only one embedding model at a time.
let reindexState = {
  running: false,
  done: 0,
  failed: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
};

/**
 * Builds the model tag stored alongside each embedding. It encodes both the
 * provider and the model name so a model switch invalidates old vectors (they
 * simply stop matching the current tag during search/reindex).
 *
 * @param {Object} cfg -> RAG config from settingsService.
 * @returns {string} -> e.g. 'ollama:nomic-embed-text'.
 */
function modelTag(cfg) {
  return `${cfg.mode}:${cfg.model}`;
}

/**
 * Reports whether semantic search is active (a provider and model are set).
 *
 * @returns {boolean} -> True when embeddings should be produced/used.
 */
function isEnabled() {
  const cfg = settingsService.getRagConfig();
  return cfg.mode !== RAG_MODE.OFF && Boolean(cfg.model);
}

/**
 * Truncates the embed input so very large tickets stay within the context
 * window of small embedding models. The ticket markdown starts with the summary
 * heading, so the leading slice already captures the most relevant text.
 *
 * @param {string} text -> Raw text.
 * @returns {string} -> Truncated text.
 */
function prepareText(text) {
  return String(text || '').slice(0, EMBEDDING_MAX_CHARS);
}

/**
 * Serializes a Float32 vector into a Buffer for BLOB storage.
 *
 * @param {Float32Array|number[]} vector -> The embedding.
 * @returns {Buffer} -> Little-endian Float32 bytes.
 */
function toBlob(vector) {
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Deserializes a stored BLOB back into a Float32Array. The buffer is copied so
 * the typed-array view is correctly aligned regardless of SQLite's allocation.
 *
 * @param {Buffer} buf -> Stored embedding bytes.
 * @returns {Float32Array} -> The embedding.
 */
function fromBlob(buf) {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 when either
 * vector has zero magnitude.
 *
 * @param {Float32Array} a -> First vector.
 * @param {Float32Array} b -> Second vector.
 * @returns {number} -> Similarity in [-1, 1].
 */
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Requests an embedding from a local Ollama instance.
 *
 * @param {Object} cfg -> RAG config.
 * @param {string} text -> Prepared input text.
 * @returns {Promise<Float32Array>} -> The embedding vector.
 * @throws {Error} -> On HTTP failure or empty response.
 */
async function embedViaOllama(cfg, text) {
  const url = `${cfg.ollamaUrl}/api/embeddings`;
  const res = await axios.post(url, { model: cfg.model, prompt: text }, { timeout: HTTP_TIMEOUT_MS });
  const vec = res.data && res.data.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('Ollama lieferte kein Embedding zurück (Modell installiert?).');
  }
  return Float32Array.from(vec);
}

/**
 * Requests an embedding from the OpenAI embeddings API.
 *
 * @param {Object} cfg -> RAG config (must carry a decrypted openaiApiKey).
 * @param {string} text -> Prepared input text.
 * @returns {Promise<Float32Array>} -> The embedding vector.
 * @throws {Error} -> When the key is missing, or on HTTP/empty response.
 */
async function embedViaOpenAi(cfg, text) {
  if (!cfg.openaiApiKey) throw new Error('OpenAI API-Key fehlt.');
  const res = await axios.post(
    OPENAI_EMBEDDINGS_URL,
    { model: cfg.model, input: text },
    { timeout: HTTP_TIMEOUT_MS, headers: { Authorization: `Bearer ${cfg.openaiApiKey}` } },
  );
  const vec = res.data && res.data.data && res.data.data[0] && res.data.data[0].embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('OpenAI lieferte kein Embedding zurück.');
  }
  return Float32Array.from(vec);
}

/**
 * Requests an embedding from an existing Open WebUI connection. Reuses the
 * URL + token of a configured knowledge target (referenced by cfg.targetId), so
 * no separate provider has to be set up. The response is parsed defensively to
 * cover both the OpenAI-style ({ data: [{ embedding }] }) and Ollama-style
 * ({ embedding }) shapes Open WebUI may return depending on the backing model.
 *
 * @param {Object} cfg -> RAG config (must carry a targetId and model).
 * @param {string} text -> Prepared input text.
 * @returns {Promise<Float32Array>} -> The embedding vector.
 * @throws {Error} -> When the connection is missing, or on HTTP/empty response.
 */
async function embedViaOpenWebUi(cfg, text) {
  const target = settingsService.getTarget(cfg.targetId);
  if (!target || !target.url) {
    throw new Error('Keine Open-WebUI-Verbindung ausgewählt.');
  }
  const res = await axios.post(
    `${target.url}/api/embeddings`,
    { model: cfg.model, input: text },
    { timeout: HTTP_TIMEOUT_MS, headers: { Authorization: `Bearer ${target.token || ''}` } },
  );
  const data = res.data;
  const vec = (data && data.data && data.data[0] && data.data[0].embedding) || (data && data.embedding);
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('Open WebUI lieferte kein Embedding zurück (Modell geeignet?).');
  }
  return Float32Array.from(vec);
}

/**
 * Resolves the effective local model name, falling back to the bundled default
 * when the admin left the field empty.
 *
 * @param {Object} cfg -> RAG config.
 * @returns {string} -> A non-empty model id.
 */
function localModelName(cfg) {
  return cfg.model || DEFAULT_LOCAL_EMBED_MODEL;
}

/**
 * Returns a cached Transformers.js feature-extraction pipeline for the given
 * model, building (and downloading) it on first use. Rebuilds when the model
 * changes so a model switch in the dashboard takes effect.
 *
 * @param {string} modelName -> Hugging Face model id (e.g. 'Xenova/...').
 * @returns {Promise<Function>} -> The extractor pipeline.
 */
async function getLocalExtractor(modelName) {
  if (localExtractor.pipe && localExtractor.model === modelName) {
    return localExtractor.pipe;
  }
  // @huggingface/transformers is ESM-only; load it via dynamic import so it
  // works from this CommonJS module.
  const { pipeline } = await import('@huggingface/transformers');
  const pipe = await pipeline('feature-extraction', modelName);
  localExtractor = { model: modelName, pipe };
  return pipe;
}

/**
 * Embeds text in-process with Transformers.js (ONNX runtime). Needs no external
 * service and no GPU, which makes it the middle ground between cloud embeddings
 * (OpenAI) and a dedicated local server (Ollama). The model is downloaded and
 * cached on first use, so the first call after a (re)start is slower.
 *
 * @param {Object} cfg -> RAG config.
 * @param {string} text -> Prepared input text.
 * @returns {Promise<Float32Array>} -> The embedding vector.
 * @throws {Error} -> When the model yields an empty vector.
 */
async function embedViaLocal(cfg, text) {
  const extractor = await getLocalExtractor(localModelName(cfg));
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  const vec = Float32Array.from(out.data);
  if (vec.length === 0) {
    throw new Error('Lokales Embedding-Modell lieferte keinen Vektor.');
  }
  return vec;
}

/**
 * Embeds arbitrary text with the currently configured provider/model.
 *
 * @param {string} text -> Input text.
 * @returns {Promise<{vector: Float32Array, model: string, dim: number}>} -> Result.
 * @throws {Error} -> When RAG is off/misconfigured or the provider call fails.
 */
async function embed(text) {
  const cfg = settingsService.getRagConfig();
  if (cfg.mode === RAG_MODE.OFF) throw new Error('RAG ist deaktiviert.');
  if (cfg.mode !== RAG_MODE.LOCAL && !cfg.model) {
    throw new Error('Kein Embedding-Modell konfiguriert.');
  }
  const prepared = prepareText(text);
  let vector;
  if (cfg.mode === RAG_MODE.OLLAMA) {
    vector = await embedViaOllama(cfg, prepared);
  } else if (cfg.mode === RAG_MODE.OPENAI) {
    vector = await embedViaOpenAi(cfg, prepared);
  } else if (cfg.mode === RAG_MODE.OPENWEBUI) {
    vector = await embedViaOpenWebUi(cfg, prepared);
  } else {
    vector = await embedViaLocal(cfg, prepared);
  }
  return { vector, model: modelTag(cfg), dim: vector.length };
}

/**
 * Embeds a ticket's markdown and stores the vector. Throws on failure so the
 * caller can decide how to record it (the workflow marks the ticket 'failed').
 *
 * @param {string} jiraId -> Issue key.
 * @param {string} markdown -> The ticket markdown.
 * @returns {Promise<{vector: Float32Array, model: string, dim: number}>} -> Result.
 */
async function embedTicket(jiraId, markdown) {
  log('embedTicket called with: %o', { jiraId });
  const res = await embed(markdown);
  queries.updateTicketEmbedding(jiraId, toBlob(res.vector), res.model, res.dim);
  return res;
}

/**
 * Ranks a connection's embedded docs against a query by cosine similarity.
 * Returns [] when RAG is off; the query is embedded with the current model and
 * only docs embedded with that same model are considered.
 *
 * @param {Object} connection -> mcp_connections row.
 * @param {string} query -> Search query.
 * @param {number} limit -> Max results.
 * @returns {Promise<Object[]>} -> Rows with jira_id, summary, markdown, score.
 */
async function semanticSearch(connection, query, limit) {
  const cfg = settingsService.getRagConfig();
  if (cfg.mode === RAG_MODE.OFF || !cfg.model) return [];
  const res = await embed(query);
  const rows = queries.listEmbeddedDocs(connection, res.model);
  if (rows.length === 0) return [];
  const scored = rows.map((row) => ({
    jira_id: row.jira_id,
    summary: row.summary,
    markdown: row.markdown,
    markdown_size: row.markdown_size,
    updated_at: row.updated_at,
    score: cosine(res.vector, fromBlob(row.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}

/**
 * Emits the current reindex progress to the dashboard.
 *
 * @returns {void}
 */
function emitProgress() {
  socketService.emitRagProgress({ ...reindexState });
}

/**
 * (Re-)embeds every active ticket that lacks a current embedding for the
 * configured model. Runs sequentially so a local Ollama is not overwhelmed, and
 * pushes progress over Socket.IO. Per-ticket failures are recorded and skipped;
 * they never abort the run.
 *
 * @returns {Promise<Object>} -> Summary, or a skip/already-running marker.
 */
async function reindexAll() {
  log('reindexAll called');
  const cfg = settingsService.getRagConfig();
  if (cfg.mode === RAG_MODE.OFF || !cfg.model) return { skipped: true };
  if (reindexState.running) return { alreadyRunning: true };

  const model = modelTag(cfg);
  const rows = queries.listTicketsForEmbedding(model);
  reindexState = { running: true, done: 0, failed: 0, total: rows.length, startedAt: Date.now(), finishedAt: null };
  emitProgress();

  for (const row of rows) {
    try {
      await embedTicket(row.jira_id, row.markdown);
      reindexState.done += 1;
    } catch (err) {
      log('reindex failed for %s: %s', row.jira_id, err.message);
      queries.setTicketEmbeddingStatus(row.jira_id, EMBEDDING_STATUS.FAILED);
      reindexState.failed += 1;
    }
    emitProgress();
  }

  reindexState.running = false;
  reindexState.finishedAt = Date.now();
  emitProgress();
  return { done: reindexState.done, failed: reindexState.failed, total: reindexState.total };
}

/**
 * Returns the current RAG status (config summary + coverage + reindex progress)
 * for the admin dashboard.
 *
 * @returns {Object} -> Status snapshot.
 */
function getStatus() {
  const cfg = settingsService.getRagConfig();
  const stats = queries.getEmbeddingStats(modelTag(cfg));
  return {
    mode: cfg.mode,
    model: cfg.model,
    enabled: isEnabled(),
    running: reindexState.running,
    progress: { done: reindexState.done, failed: reindexState.failed, total: reindexState.total },
    stats,
  };
}

/**
 * Probes the configured embedding provider by embedding a short test string.
 *
 * @returns {Promise<{ok: boolean, dim: number, model: string}>} -> Probe result.
 * @throws {Error} -> When the provider call fails.
 */
async function testConnection() {
  const res = await embed('KnowFlow Verbindungstest');
  return { ok: true, dim: res.dim, model: res.model };
}

module.exports = {
  isEnabled,
  embed,
  embedTicket,
  semanticSearch,
  reindexAll,
  getStatus,
  testConnection,
  // Exposed for unit testing of the pure helpers.
  toBlob,
  fromBlob,
  cosine,
};
