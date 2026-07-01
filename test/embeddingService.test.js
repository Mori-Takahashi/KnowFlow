'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RAG_MODE, DEFAULT_LOCAL_EMBED_MODEL, DEFAULT_RAG_CONFIG } = require('../src/constants');
const embeddingService = require('../src/services/embeddingService');
const { looksLikeEmbeddingModel } = require('../src/services/openwebuiService');

// These tests cover the network-free parts of the embedding service. The local
// provider's actual inference is exercised separately (it downloads a model on
// first use), so here we only assert the wiring and the pure helpers.

test('RAG_MODE exposes the in-process local provider', () => {
  assert.equal(RAG_MODE.LOCAL, 'local');
});

test('a default local model is bundled', () => {
  assert.equal(typeof DEFAULT_LOCAL_EMBED_MODEL, 'string');
  assert.ok(DEFAULT_LOCAL_EMBED_MODEL.length > 0);
});

test('toBlob/fromBlob round-trips a Float32 vector', () => {
  const original = Float32Array.from([0.1, -0.5, 1.0, 0]);
  const restored = embeddingService.fromBlob(embeddingService.toBlob(original));
  assert.equal(restored.length, original.length);
  for (let i = 0; i < original.length; i += 1) {
    assert.ok(Math.abs(restored[i] - original[i]) < 1e-6);
  }
});

test('cosine is 1 for identical vectors and 0 for orthogonal ones', () => {
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([0, 1, 0]);
  assert.ok(Math.abs(embeddingService.cosine(a, a) - 1) < 1e-6);
  assert.equal(embeddingService.cosine(a, b), 0);
});

test('cosine returns 0 when a vector has zero magnitude', () => {
  const zero = Float32Array.from([0, 0, 0]);
  const v = Float32Array.from([1, 2, 3]);
  assert.equal(embeddingService.cosine(zero, v), 0);
});

test('RAG_MODE exposes the Open WebUI provider', () => {
  assert.equal(RAG_MODE.OPENWEBUI, 'openwebui');
});

test('DEFAULT_RAG_CONFIG carries an empty Open WebUI targetId', () => {
  assert.equal(DEFAULT_RAG_CONFIG.targetId, '');
});

test('looksLikeEmbeddingModel flags embedding models and rejects chat models', () => {
  for (const name of [
    'nomic-embed-text',
    'text-embedding-3-small',
    'bge-m3',
    'multilingual-e5-large',
    'mxbai-embed-large',
    'snowflake-arctic-embed',
  ]) {
    assert.ok(looksLikeEmbeddingModel(name), `${name} should look like an embedding model`);
  }
  for (const name of ['llama3', 'mistral', 'gpt-4o', 'qwen2.5', '']) {
    assert.equal(looksLikeEmbeddingModel(name), false, `${name} should not look like an embedding model`);
  }
});
