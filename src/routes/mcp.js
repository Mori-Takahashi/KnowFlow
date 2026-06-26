'use strict';

const crypto = require('crypto');
const express = require('express');
const debug = require('debug');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const queries = require('../db/queries');
const oauthService = require('../services/oauthService');
const { createRateLimiter } = require('../middleware/rateLimit');

const log = debug('knowflow:routes:mcp');

// JSON-RPC error code for "method not found" / generic server errors.
const JSONRPC_METHOD_NOT_ALLOWED = -32000;
const JSONRPC_INTERNAL_ERROR = -32603;
// JSON-RPC error code used for an unauthorized request (mirrors HTTP 401).
const JSONRPC_UNAUTHORIZED = -32001;

/**
 * Extracts the bearer token a client presented, accepting both the standard
 * `Authorization: Bearer <token>` header and an `x-mcp-token` header for clients
 * that cannot set Authorization.
 *
 * @param {import('express').Request} req -> The request.
 * @returns {string} -> The presented token, or ''.
 */
function presentedToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  if (match) return match[1].trim();
  return (req.get('x-mcp-token') || '').trim();
}

/**
 * Constant-time string comparison that tolerates differing lengths.
 *
 * @param {string} a -> First value.
 * @param {string} b -> Second value.
 * @returns {boolean} -> True when equal.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Builds a JSON-RPC 2.0 error envelope.
 *
 * @param {number} code -> JSON-RPC error code.
 * @param {string} message -> Human-readable message.
 * @returns {Object} -> JSON-RPC error response.
 */
function jsonRpcError(code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * Builds the MCP router. Each connection is exposed as a stateless Streamable
 * HTTP endpoint at POST /mcp/:slug. GET/DELETE are not supported (no sessions).
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.mcpService -> MCP service (buildServer).
 * @param {Object} deps.settingsService -> Settings store (MCP token lookup).
 * @param {Object} deps.config -> App config (publicBaseUrl for the OAuth pointer).
 * @returns {import('express').Router} -> Configured router.
 */
function createMcpRouter({ mcpService, settingsService, config }) {
  log('createMcpRouter called');
  const router = express.Router();
  const baseUrl = String(config?.publicBaseUrl || '').replace(/\/$/, '');

  const mcpLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

  router.post('/:slug', mcpLimiter, async (req, res) => {
    log('POST /mcp/:slug %o', { slug: req.params.slug });
    const conn = queries.getMcpConnection(req.params.slug);
    if (!conn) {
      res.status(404).json(jsonRpcError(JSONRPC_METHOD_NOT_ALLOWED, 'Unbekannte MCP-Verbindung'));
      return;
    }

    // Optional per-connection authentication. When enabled, a request is
    // accepted if it presents either the static per-connection bearer token, or
    // a valid OAuth access token issued for this connection. Otherwise a 401 is
    // returned with a pointer to the protected-resource metadata so OAuth-only
    // clients (e.g. Claude) can discover the authorization server.
    if (conn.require_auth === 1) {
      const provided = presentedToken(req);
      const expected = settingsService.getMcpToken(conn.id);
      const staticOk = Boolean(expected) && Boolean(provided) && safeEqual(provided, expected);
      const oauthOk = Boolean(provided) && Boolean(oauthService.verifyAccessToken(provided, conn.id));
      if (!staticOk && !oauthOk) {
        log('POST /mcp/:slug rejected (auth) %o', { slug: req.params.slug });
        res.set(
          'WWW-Authenticate',
          `Bearer realm="KnowFlow MCP", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(conn.id)}"`,
        );
        res.status(401).json(jsonRpcError(JSONRPC_UNAUTHORIZED, 'Nicht autorisiert: Authentifizierung erforderlich.'));
        return;
      }
    }

    try {
      const server = mcpService.buildServer(conn);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] handleRequest failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(JSONRPC_INTERNAL_ERROR, err.message));
      }
    }
  });

  // Stateless mode: server-to-client streams and session teardown are not
  // supported, so GET and DELETE are rejected with a JSON-RPC error.
  const methodNotAllowed = (_req, res) => {
    res.status(405).json(jsonRpcError(JSONRPC_METHOD_NOT_ALLOWED, 'Methode im statuslosen Modus nicht erlaubt.'));
  };
  router.get('/:slug', methodNotAllowed);
  router.delete('/:slug', methodNotAllowed);

  return router;
}

module.exports = { createMcpRouter };
