'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jiraOAuthService = require('../src/services/jiraOAuthService');

test.beforeEach(() => {
  delete process.env.JIRA_OAUTH_CLIENT_ID;
  delete process.env.JIRA_OAUTH_CLIENT_SECRET;
});

test('isConfigured requires both client id and secret', () => {
  assert.equal(jiraOAuthService.isConfigured(), false);
  process.env.JIRA_OAUTH_CLIENT_ID = 'id';
  assert.equal(jiraOAuthService.isConfigured(), false);
  process.env.JIRA_OAUTH_CLIENT_SECRET = 'secret';
  assert.equal(jiraOAuthService.isConfigured(), true);
});

test('buildAuthorizeUrl requests offline_access so a refresh token is issued', () => {
  process.env.JIRA_OAUTH_CLIENT_ID = 'id';
  process.env.JIRA_OAUTH_CLIENT_SECRET = 'secret';

  const url = new URL(jiraOAuthService.buildAuthorizeUrl({
    redirectUri: 'https://knowflow.example.com/api/jira/oauth/callback',
    state: 'state-123',
  }));

  assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
  assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
  assert.equal(url.searchParams.get('client_id'), 'id');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://knowflow.example.com/api/jira/oauth/callback',
  );
  const scopes = url.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('offline_access'));
  assert.ok(scopes.includes('read:jira-work'));
  assert.ok(scopes.includes('write:jira-work'));
});

test('buildAuthorizeUrl fails fast when OAuth is not configured', () => {
  assert.throws(
    () => jiraOAuthService.buildAuthorizeUrl({ redirectUri: 'https://x/cb', state: 's' }),
    /nicht konfiguriert/,
  );
});

test('getValidAccessToken returns the stored token while it is still valid', async () => {
  const settings = {
    getJiraConfig: () => ({
      accessToken: 'still-good',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
  };
  assert.equal(await jiraOAuthService.getValidAccessToken(settings), 'still-good');
});

test('getValidAccessToken reports a missing connection instead of refreshing', async () => {
  const settings = { getJiraConfig: () => ({ accessToken: '', refreshToken: '', expiresAt: 0 }) };
  await assert.rejects(
    () => jiraOAuthService.getValidAccessToken(settings),
    /nicht über OAuth verbunden/,
  );
});

test('an expired token without a refresh token asks the operator to reconnect', async () => {
  process.env.JIRA_OAUTH_CLIENT_ID = 'id';
  process.env.JIRA_OAUTH_CLIENT_SECRET = 'secret';
  const settings = {
    getJiraConfig: () => ({ accessToken: 'expired', refreshToken: '', expiresAt: Date.now() - 1000 }),
  };
  await assert.rejects(
    () => jiraOAuthService.getValidAccessToken(settings),
    /erneut verbinden/,
  );
});
