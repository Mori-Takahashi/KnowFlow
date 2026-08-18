'use strict';

const axios = require('axios');
const debug = require('debug');

const log = debug('knowflow:jiraOAuthService');

// Atlassian 3LO endpoints (identical for every Jira Cloud site).
const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const ME_URL = 'https://api.atlassian.com/me';

// `offline_access` is what makes Atlassian hand out a refresh token; without it
// the connection dies after one hour and the operator has to re-authorize.
const SCOPES = ['read:jira-work', 'write:jira-work', 'offline_access'];

// Refresh this long before the recorded expiry so in-flight requests never race
// an expiring token.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const HTTP_TIMEOUT_MS = 15000;

/**
 * Returns the configured OAuth client credentials, or null when Jira OAuth has
 * not been set up in the environment.
 *
 * @returns {{clientId: string, clientSecret: string}|null} -> The credentials.
 */
function getClientCredentials() {
  const clientId = process.env.JIRA_OAUTH_CLIENT_ID;
  const clientSecret = process.env.JIRA_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Whether Jira OAuth is available (client id + secret configured).
 *
 * @returns {boolean} -> True when the OAuth flow can be started.
 */
function isConfigured() {
  return Boolean(getClientCredentials());
}

/**
 * Builds the Atlassian authorization URL the browser is redirected to.
 *
 * @param {Object} args -> Arguments.
 * @param {string} args.redirectUri -> The registered callback URL.
 * @param {string} args.state -> Opaque CSRF state.
 * @returns {string} -> The authorization URL.
 * @throws {Error} -> If OAuth is not configured.
 */
function buildAuthorizeUrl({ redirectUri, state }) {
  const creds = getClientCredentials();
  if (!creds) {
    throw new Error('Jira OAuth ist nicht konfiguriert (JIRA_OAUTH_CLIENT_ID/SECRET fehlen).');
  }
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * Exchanges an authorization code for tokens and resolves the Jira Cloud site
 * the tokens grant access to.
 *
 * @param {Object} args -> Arguments.
 * @param {string} args.code -> The authorization code from the callback.
 * @param {string} args.redirectUri -> The same redirect URI used to authorize.
 * @returns {Promise<Object>} -> { accessToken, refreshToken, expiresAt, cloudId, siteUrl, accountId, accountName, sites }
 * @throws {Error} -> If the exchange fails or no Jira site is accessible.
 */
async function exchangeCode({ code, redirectUri }) {
  log('exchangeCode called');
  const creds = getClientCredentials();
  if (!creds) {
    throw new Error('Jira OAuth ist nicht konfiguriert (JIRA_OAUTH_CLIENT_ID/SECRET fehlen).');
  }

  const tokenResp = await axios.post(
    TOKEN_URL,
    {
      grant_type: 'authorization_code',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT_MS },
  );

  const accessToken = tokenResp.data?.access_token;
  if (!accessToken) throw new Error('Atlassian hat kein Access-Token zurückgegeben.');
  const refreshToken = tokenResp.data?.refresh_token || '';
  const expiresIn = Number(tokenResp.data?.expires_in) || 3600;

  const resourcesResp = await axios.get(RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    timeout: HTTP_TIMEOUT_MS,
  });
  const sites = Array.isArray(resourcesResp.data) ? resourcesResp.data : [];
  const jiraSites = sites.filter((s) => Array.isArray(s.scopes)
    ? s.scopes.some((scope) => scope.includes('jira'))
    : true);
  if (jiraSites.length === 0) {
    throw new Error('Für dieses Atlassian-Konto ist keine Jira-Cloud-Instanz freigegeben.');
  }
  const site = jiraSites[0];

  let accountId = '';
  let accountName = '';
  try {
    const meResp = await axios.get(ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      timeout: HTTP_TIMEOUT_MS,
    });
    accountId = meResp.data?.account_id || '';
    accountName = meResp.data?.name || meResp.data?.email || '';
  } catch (err) {
    // The connection works without profile data; it is only used for display.
    log('me lookup failed: %s', err.message);
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    cloudId: site.id,
    siteUrl: site.url,
    accountId,
    accountName: accountName || site.name || site.url,
    sites: jiraSites.map((s) => ({ id: s.id, url: s.url, name: s.name })),
  };
}

/**
 * Redeems the stored refresh token for a fresh access token and persists it.
 * Atlassian rotates refresh tokens, so the new one must be stored as well.
 *
 * @param {Object} settingsService -> Settings store.
 * @returns {Promise<string>} -> The new access token.
 * @throws {Error} -> If no refresh token exists or the refresh is rejected.
 */
async function refreshAccessToken(settingsService) {
  log('refreshAccessToken called');
  const creds = getClientCredentials();
  if (!creds) {
    throw new Error('Jira OAuth ist nicht konfiguriert (JIRA_OAUTH_CLIENT_ID/SECRET fehlen).');
  }
  const cfg = settingsService.getJiraConfig();
  if (!cfg.refreshToken) {
    throw new Error('Jira-OAuth-Token ist abgelaufen und es liegt kein Refresh-Token vor. Bitte Jira erneut verbinden.');
  }

  const resp = await axios.post(
    TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: cfg.refreshToken,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT_MS },
  );

  const accessToken = resp.data?.access_token;
  if (!accessToken) throw new Error('Atlassian hat beim Token-Refresh kein Access-Token zurückgegeben.');
  const expiresIn = Number(resp.data?.expires_in) || 3600;

  settingsService.setJiraOAuthTokens({
    accessToken,
    // Keep the previous token when Atlassian does not rotate it.
    refreshToken: resp.data?.refresh_token || cfg.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return accessToken;
}

/**
 * Returns a usable access token, refreshing it when it is expired or about to
 * expire.
 *
 * @param {Object} settingsService -> Settings store.
 * @returns {Promise<string>} -> A valid access token.
 * @throws {Error} -> If no OAuth connection exists or the refresh fails.
 */
async function getValidAccessToken(settingsService) {
  const cfg = settingsService.getJiraConfig();
  if (!cfg.accessToken) {
    throw new Error('Jira ist nicht über OAuth verbunden.');
  }
  if (cfg.expiresAt && cfg.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return cfg.accessToken;
  }
  return refreshAccessToken(settingsService);
}

module.exports = {
  SCOPES,
  isConfigured,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getValidAccessToken,
};
