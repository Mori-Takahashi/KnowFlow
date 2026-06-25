'use strict';

const express = require('express');
const debug = require('debug');

const queries = require('../db/queries');
const oauthService = require('../services/oauthService');
const { createRateLimiter } = require('../middleware/rateLimit');

const log = debug('knowflow:routes:oauth');

/**
 * HTML-escapes a value for safe interpolation into attribute/text contexts.
 *
 * @param {*} value -> Raw value.
 * @returns {string} -> Escaped string.
 */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Extracts the MCP connection slug from an RFC 8707 `resource` value such as
 * `https://host/mcp/mcp-1`.
 *
 * @param {string} resource -> The resource indicator.
 * @returns {string|null} -> The slug, or null.
 */
function connFromResource(resource) {
  if (!resource) return null;
  const m = /\/mcp\/([^/?#]+)/.exec(String(resource));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Builds the OAuth 2.1 router that turns KnowFlow into an authorization server
 * + protected resource for its MCP endpoints, so OAuth-only MCP clients (e.g.
 * the Claude custom connector) can authenticate. The flow is stateless: codes
 * and tokens are HMAC-signed (see oauthService), and dynamic clients encode
 * their redirect URIs in the issued client_id.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.config -> App config (publicBaseUrl).
 * @param {Object} deps.authService -> Auth service (password -> role).
 * @returns {import('express').Router} -> Configured router.
 */
function createOAuthRouter({ config, authService }) {
  log('createOAuthRouter called');
  const router = express.Router();
  const baseUrl = String(config.publicBaseUrl || '').replace(/\/$/, '');

  // Throttle password guessing against the OAuth login (password submission).
  const authorizeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

  /**
   * Applies permissive CORS headers used on the JSON discovery/token endpoints.
   *
   * @param {import('express').Response} res -> Response.
   * @returns {void}
   */
  function cors(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  /**
   * Protected Resource Metadata (RFC 9728) for a connection (or generically).
   *
   * @param {string|null} slug -> Connection slug, or null for the generic doc.
   * @returns {Object} -> The metadata document.
   */
  function protectedResourceMetadata(slug) {
    const resource = slug ? `${baseUrl}/mcp/${encodeURIComponent(slug)}` : baseUrl;
    return {
      resource,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    };
  }

  /**
   * Authorization Server Metadata (RFC 8414).
   *
   * @returns {Object} -> The metadata document.
   */
  function authServerMetadata() {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
    };
  }

  // ---- Discovery endpoints (CORS-enabled, no auth) ------------------------

  router.options('/.well-known/{*path}', (_req, res) => { cors(res); res.status(204).end(); });

  router.get('/.well-known/oauth-protected-resource/mcp/:slug', (req, res) => {
    log('GET protected-resource-metadata %o', { slug: req.params.slug });
    cors(res);
    res.json(protectedResourceMetadata(req.params.slug));
  });

  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    cors(res);
    res.json(protectedResourceMetadata(null));
  });

  // Some clients append the resource path to the AS metadata probe; serve the
  // same document on both the bare and path-suffixed variants.
  router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/{*path}'], (_req, res) => {
    cors(res);
    res.json(authServerMetadata());
  });

  // ---- Dynamic Client Registration (RFC 7591) ----------------------------

  router.options('/oauth/register', (_req, res) => { cors(res); res.status(204).end(); });

  router.post('/oauth/register', (req, res) => {
    log('POST /oauth/register');
    cors(res);
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string' && u) : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris ist erforderlich.' });
      return;
    }
    const clientId = oauthService.issueClientId(redirectUris);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
      scope: 'mcp',
    });
  });

  // ---- Authorization endpoint --------------------------------------------

  /**
   * Renders the login page presented during the authorization step.
   *
   * @param {Object} params -> The authorization request parameters.
   * @param {string|null} error -> Optional error message to display.
   * @param {string} connTitle -> The connection's display title.
   * @returns {string} -> HTML document.
   */
  function loginPage(params, error, connTitle) {
    const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource']
      .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('\n');
    return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KnowFlow · Anmeldung</title>
<style>
  :root{--bg:#f6f7fb;--card:#fff;--border:#e5e8ef;--ink:#0f1729;--muted:#64748b;--brand:#4f46e5;}
  *{box-sizing:border-box} body{margin:0;font-family:Inter,system-ui,Arial,sans-serif;background:var(--bg);color:var(--ink);
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);border-radius:14px;
    padding:26px;box-shadow:0 10px 30px rgba(15,23,41,.08)}
  .brand{width:44px;height:44px;border-radius:10px;background:var(--brand);color:#fff;font-weight:700;
    display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:16px}
  h1{font-size:19px;text-align:center;margin:0 0 4px} p.sub{font-size:13px;color:var(--muted);text-align:center;margin:0 0 18px}
  label{font-size:12px;color:var(--muted);display:block;margin-bottom:6px}
  input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:9px;font-size:14px}
  button{width:100%;margin-top:16px;padding:11px;border:none;border-radius:9px;background:var(--brand);color:#fff;
    font-size:14px;font-weight:600;cursor:pointer}
  .err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:9px;padding:9px 12px;font-size:12.5px;margin-bottom:14px}
  .conn{background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:9px;padding:9px 12px;font-size:12.5px;margin-bottom:14px}
</style></head>
<body><form class="card" method="post" action="/oauth/authorize">
  <div class="brand">JB</div>
  <h1>KnowFlow</h1>
  <p class="sub">Zugriff auf eine MCP-Verbindung autorisieren</p>
  ${connTitle ? `<div class="conn"><b>${esc(connTitle)}</b> möchte auf dein KnowFlow-Wissen zugreifen.</div>` : ''}
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  ${hidden}
  <label>Passwort (Admin oder Benutzer)</label>
  <input type="password" name="password" autofocus autocomplete="current-password" placeholder="Passwort">
  <button type="submit">Anmelden &amp; autorisieren</button>
</form></body></html>`;
  }

  /**
   * Validates the shared authorization-request parameters.
   *
   * @param {Object} p -> The parameters (query or body).
   * @returns {{ok: true, conn: string, client: Object}|{ok: false, status: number, message: string, redirectable?: boolean}} -> Result.
   */
  function validateAuthParams(p) {
    if (p.response_type !== 'code') {
      return { ok: false, status: 400, message: 'Nur response_type=code wird unterstützt.' };
    }
    if (!p.code_challenge || p.code_challenge_method !== 'S256') {
      return { ok: false, status: 400, message: 'PKCE mit code_challenge_method=S256 ist erforderlich.' };
    }
    const client = oauthService.parseClientId(p.client_id);
    if (!client) {
      return { ok: false, status: 400, message: 'Unbekannte oder ungültige client_id.' };
    }
    if (!p.redirect_uri || !client.ru.includes(p.redirect_uri)) {
      return { ok: false, status: 400, message: 'redirect_uri ist nicht für diesen Client registriert.' };
    }
    const conn = connFromResource(p.resource);
    if (!conn || !queries.getMcpConnection(conn)) {
      return { ok: false, status: 400, message: 'Unbekannte MCP-Verbindung (resource).' };
    }
    return { ok: true, conn, client };
  }

  router.get('/oauth/authorize', (req, res) => {
    log('GET /oauth/authorize');
    const p = req.query || {};
    const check = validateAuthParams(p);
    if (!check.ok) {
      res.status(check.status).type('html').send(loginPage(p, check.message, null));
      return;
    }
    const conn = queries.getMcpConnection(check.conn);
    res.type('html').send(loginPage(p, null, conn ? conn.title : null));
  });

  router.post('/oauth/authorize', authorizeLimiter, (req, res) => {
    log('POST /oauth/authorize');
    const p = req.body || {};
    const check = validateAuthParams(p);
    if (!check.ok) {
      res.status(check.status).type('html').send(loginPage(p, check.message, null));
      return;
    }
    const conn = queries.getMcpConnection(check.conn);
    const role = authService.authenticate(p.password);
    if (!role) {
      res.status(401).type('html').send(loginPage(p, 'Falsches Passwort.', conn ? conn.title : null));
      return;
    }
    const code = oauthService.issueCode({
      conn: check.conn,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge,
      role,
    });
    let target;
    try {
      target = new URL(p.redirect_uri);
    } catch (_err) {
      res.status(400).type('html').send(loginPage(p, 'Ungültige redirect_uri.', null));
      return;
    }
    target.searchParams.set('code', code);
    if (p.state) target.searchParams.set('state', p.state);
    res.redirect(302, target.toString());
  });

  // ---- Token endpoint -----------------------------------------------------

  router.options('/oauth/token', (_req, res) => { cors(res); res.status(204).end(); });

  router.post('/oauth/token', (req, res) => {
    log('POST /oauth/token %o', { grant: req.body?.grant_type });
    cors(res);
    res.set('Cache-Control', 'no-store');
    const body = req.body || {};
    const grant = body.grant_type;

    if (grant === 'authorization_code') {
      const codePayload = oauthService.verifyCode(body.code);
      if (!codePayload) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Code ungültig oder abgelaufen.' });
        return;
      }
      if (body.redirect_uri !== codePayload.ru) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri stimmt nicht überein.' });
        return;
      }
      if (!oauthService.verifyPkce(body.code_verifier, codePayload.cc)) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE-Prüfung fehlgeschlagen.' });
        return;
      }
      res.json(tokenResponse(codePayload.conn, codePayload.role));
      return;
    }

    if (grant === 'refresh_token') {
      const refreshPayload = oauthService.verifyRefreshToken(body.refresh_token);
      if (!refreshPayload) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh-Token ungültig oder abgelaufen.' });
        return;
      }
      res.json(tokenResponse(refreshPayload.conn, refreshPayload.role));
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  /**
   * Builds an OAuth token response (access + refresh token) for a connection.
   *
   * @param {string} conn -> Connection id.
   * @param {string} role -> Authenticated role.
   * @returns {Object} -> The token response.
   */
  function tokenResponse(conn, role) {
    return {
      access_token: oauthService.issueAccessToken({ conn, role }),
      token_type: 'Bearer',
      expires_in: Math.floor(oauthService.ACCESS_TTL_MS / 1000),
      refresh_token: oauthService.issueRefreshToken({ conn, role }),
      scope: 'mcp',
    };
  }

  return router;
}

module.exports = { createOAuthRouter };
