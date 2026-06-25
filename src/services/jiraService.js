'use strict';

const axios = require('axios');
const debug = require('debug');

const {
  HTTP_TIMEOUT_MS,
  COMMENT_TEMPLATES,
  COMMENT_ERROR_MAX_LENGTH,
} = require('../constants');

const log = debug('knowflow:jiraService');

/**
 * Builds the Basic-Auth header value from email + API token.
 *
 * @param {string} email -> Atlassian account email.
 * @param {string} token -> Atlassian API token.
 * @returns {string} -> Authorization header value.
 */
function buildAuthHeader(email, token) {
  const raw = `${email}:${token}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Creates an axios client preconfigured for the Jira Cloud REST API.
 *
 * @param {Object} jiraConfig -> Jira section of the app config.
 * @param {string} jiraConfig.baseUrl -> Jira workspace base URL.
 * @param {string} jiraConfig.email -> Atlassian account email.
 * @param {string} jiraConfig.apiToken -> Atlassian API token.
 * @returns {import('axios').AxiosInstance} -> Configured axios instance.
 */
function createClient(jiraConfig) {
  log('createClient called with: %o', { baseUrl: jiraConfig.baseUrl });
  return axios.create({
    baseURL: jiraConfig.baseUrl,
    timeout: HTTP_TIMEOUT_MS,
    headers: {
      Authorization: buildAuthHeader(jiraConfig.email, jiraConfig.apiToken),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Factory that returns a Jira service bound to the settings store. The axios
 * client is built lazily and rebuilt whenever the Jira credentials change in
 * the admin dashboard, so updates take effect without a restart.
 *
 * @param {Object} settingsService -> The settings service (source of Jira config).
 * @returns {Object} -> Service with getIssue, listFields, addCommentWithMention, getReporterAccountId, healthCheck.
 */
function createJiraService(settingsService) {
  log('createJiraService called');

  let cachedClient = null;
  let cachedSignature = null;

  /**
   * Returns an axios client for the current Jira configuration, rebuilding it
   * when the credentials (baseUrl/email/token) have changed.
   *
   * @returns {import('axios').AxiosInstance} -> Configured client.
   */
  function getClient() {
    const cfg = settingsService.getJiraConfig();
    const signature = `${cfg.baseUrl}|${cfg.email}|${cfg.apiToken}`;
    if (!cachedClient || signature !== cachedSignature) {
      cachedClient = createClient(cfg);
      cachedSignature = signature;
    }
    return cachedClient;
  }

  /**
   * Fetches a Jira issue including renderedFields, comments and changelog.
   *
   * @param {string} issueKey -> Jira issue key (e.g. KNOW-1093).
   * @returns {Promise<Object>} -> The raw Jira issue object.
   * @throws {Error} -> If the request fails.
   */
  async function getIssue(issueKey) {
    log('getIssue called with: %o', { issueKey });
    try {
      const resp = await getClient().get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        params: { expand: 'renderedFields,changelog' },
      });
      return resp.data;
    } catch (err) {
      console.error('[jiraService] getIssue failed:', err.message);
      throw err;
    }
  }

  /**
   * Lists all Jira fields (system + custom) for the field-mapping auto-discovery
   * in the admin dashboard.
   *
   * @returns {Promise<Object[]>} -> Array of { id, name, custom, schemaType }.
   * @throws {Error} -> If the request fails.
   */
  async function listFields() {
    log('listFields called');
    try {
      const resp = await getClient().get('/rest/api/3/field');
      const fields = Array.isArray(resp.data) ? resp.data : [];
      return fields.map((f) => ({
        id: f.id,
        name: f.name,
        custom: Boolean(f.custom),
        schemaType: f.schema?.type || null,
      }));
    } catch (err) {
      console.error('[jiraService] listFields failed:', err.message);
      throw err;
    }
  }

  /**
   * Extracts the reporter accountId from a Jira issue object.
   *
   * @param {Object} issue -> Issue payload from getIssue.
   * @returns {string|null} -> The accountId, or null if not present.
   */
  function getReporterAccountId(issue) {
    log('getReporterAccountId called');
    return issue?.fields?.reporter?.accountId ?? null;
  }

  /**
   * Builds an ADF document for a Jira comment that mentions a user and includes a link.
   *
   * @param {string|null} accountId -> Reporter accountId. If null, no mention is added.
   * @param {string} message -> The plain-text comment body (prefix).
   * @param {string} linkLabel -> Text shown for the link.
   * @param {string} linkUrl -> Target URL.
   * @returns {Object} -> ADF document body.
   */
  function buildAdfBody(accountId, message, linkLabel, linkUrl) {
    log('buildAdfBody called');
    const inline = [];
    if (accountId) {
      inline.push({ type: 'mention', attrs: { id: accountId } });
      inline.push({ type: 'text', text: ' ' });
    }
    inline.push({ type: 'text', text: message });
    inline.push({ type: 'text', text: ' ' });
    inline.push({
      type: 'text',
      text: linkLabel,
      marks: [{ type: 'link', attrs: { href: linkUrl } }],
    });

    return {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: inline,
        },
      ],
    };
  }

  /**
   * Posts an ADF comment on the given issue that mentions the reporter and links to the WebUI.
   *
   * @param {string} issueKey -> Jira issue key.
   * @param {string|null} accountId -> Reporter accountId for the mention. null disables mention.
   * @param {string} message -> Leading message text.
   * @param {Object} link -> Link descriptor.
   * @param {string} link.label -> Visible link text.
   * @param {string} link.url -> Target URL.
   * @returns {Promise<Object>} -> The Jira API response body.
   * @throws {Error} -> If the request fails.
   * @example
   * await addCommentWithMention('KNOW-1093', 'abc-123', 'Ihr Ticket wird gerade ans WebUI gesendet, siehe Status:', { label: 'KnowFlow öffnen', url: 'http://localhost:3000' });
   */
  async function addCommentWithMention(issueKey, accountId, message, link) {
    log('addCommentWithMention called with: %o', { issueKey, accountId });
    const body = { body: buildAdfBody(accountId, message, link.label, link.url) };
    try {
      const resp = await getClient().post(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
        body,
      );
      return resp.data;
    } catch (err) {
      console.error('[jiraService] addCommentWithMention failed:', err.message);
      throw err;
    }
  }

  /**
   * Builds an ADF document for the "inaccuracy reported" comment. Unlike
   * buildAdfBody it spans multiple paragraphs: an intro (with optional mention),
   * a bold-labelled "what is wrong" line, an optional correction line, and a
   * trailing link to the dashboard ticket.
   *
   * @param {string|null} accountId -> Reporter accountId for the mention, or null.
   * @param {string} whatIsWrong -> Description of the inaccuracy.
   * @param {string} correction -> Optional suggested correction ('' to omit).
   * @param {Object} link -> { label, url } trailing dashboard link.
   * @returns {Object} -> ADF document body.
   */
  function buildInaccuracyAdf(accountId, whatIsWrong, correction, link) {
    log('buildInaccuracyAdf called');
    const intro = [];
    if (accountId) {
      intro.push({ type: 'mention', attrs: { id: accountId } });
      intro.push({ type: 'text', text: ' ' });
      intro.push({ type: 'text', text: COMMENT_TEMPLATES.INACCURACY_INTRO });
    } else {
      intro.push({ type: 'text', text: COMMENT_TEMPLATES.INACCURACY_INTRO_NO_MENTION });
    }

    const content = [
      { type: 'paragraph', content: intro },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `${COMMENT_TEMPLATES.INACCURACY_WHAT_LABEL} `, marks: [{ type: 'strong' }] },
          { type: 'text', text: whatIsWrong },
        ],
      },
    ];

    if (correction) {
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: `${COMMENT_TEMPLATES.INACCURACY_CORRECTION_LABEL} `, marks: [{ type: 'strong' }] },
          { type: 'text', text: correction },
        ],
      });
    }

    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: link.label, marks: [{ type: 'link', attrs: { href: link.url } }] },
      ],
    });

    return { version: 1, type: 'doc', content };
  }

  /**
   * Posts the "inaccuracy reported" comment on a Jira issue. Used by the MCP
   * report_inaccuracy tool when a user flags an error in a knowledge article.
   *
   * @param {string} issueKey -> Jira issue key.
   * @param {string|null} accountId -> Reporter accountId for the mention, or null.
   * @param {Object} details -> { whatIsWrong: string, correction?: string }.
   * @param {Object} link -> { label, url } dashboard link.
   * @returns {Promise<Object>} -> The Jira API response body.
   * @throws {Error} -> If the request fails.
   */
  async function addInaccuracyComment(issueKey, accountId, details, link) {
    log('addInaccuracyComment called with: %o', { issueKey, hasMention: !!accountId });
    const whatIsWrong = truncateError(details?.whatIsWrong);
    const correction = details?.correction ? truncateError(details.correction) : '';
    const body = { body: buildInaccuracyAdf(accountId, whatIsWrong, correction, link) };
    try {
      const resp = await getClient().post(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
        body,
      );
      return resp.data;
    } catch (err) {
      console.error('[jiraService] addInaccuracyComment failed:', err.message);
      throw err;
    }
  }

  /**
   * Lists the transitions currently available for an issue (depends on the
   * issue's workflow and current status).
   *
   * @param {string} issueKey -> Jira issue key.
   * @returns {Promise<Object[]>} -> Array of transition objects ({ id, name, to: { name } }).
   * @throws {Error} -> If the request fails.
   */
  async function getIssueTransitions(issueKey) {
    log('getIssueTransitions called with: %o', { issueKey });
    try {
      const resp = await getClient().get(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
      );
      return Array.isArray(resp.data?.transitions) ? resp.data.transitions : [];
    } catch (err) {
      console.error('[jiraService] getIssueTransitions failed:', err.message);
      throw err;
    }
  }

  /**
   * Applies a workflow transition to an issue, moving it to a new status.
   *
   * @param {string} issueKey -> Jira issue key.
   * @param {string} transitionId -> The transition id to perform.
   * @returns {Promise<void>}
   * @throws {Error} -> If the request fails.
   */
  async function transitionIssue(issueKey, transitionId) {
    log('transitionIssue called with: %o', { issueKey, transitionId });
    try {
      await getClient().post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        transition: { id: String(transitionId) },
      });
    } catch (err) {
      console.error('[jiraService] transitionIssue failed:', err.message);
      throw err;
    }
  }

  /**
   * Truncates a free-form error message so it fits into a Jira comment without
   * exposing a full stacktrace.
   *
   * @param {string} message -> Raw error message.
   * @returns {string} -> Truncated message, at most COMMENT_ERROR_MAX_LENGTH chars.
   */
  function truncateError(message) {
    const safe = (message || 'Unbekannter Fehler').trim();
    if (safe.length <= COMMENT_ERROR_MAX_LENGTH) return safe;
    return safe.slice(0, COMMENT_ERROR_MAX_LENGTH - 1) + '…';
  }

  /**
   * Posts the "ticket received" comment in Jira.
   *
   * Mentions the reporter (if accountId known) and links to the dashboard ticket
   * detail page so the user can follow the live status.
   *
   * @param {string} issueKey -> Jira issue key.
   * @param {string|null} reporterAccountId -> Reporter accountId or null.
   * @param {string} dashboardUrl -> Deep link to the WebUI ticket page.
   * @returns {Promise<Object>} -> Jira API response.
   * @throws {Error} -> If the POST fails.
   */
  async function commentTicketReceived(issueKey, reporterAccountId, dashboardUrl) {
    log('commentTicketReceived called with: %o', { issueKey, hasMention: !!reporterAccountId });
    const message = reporterAccountId
      ? COMMENT_TEMPLATES.RECEIVED
      : COMMENT_TEMPLATES.RECEIVED_NO_MENTION;
    return addCommentWithMention(issueKey, reporterAccountId, message, {
      label: COMMENT_TEMPLATES.RECEIVED_LINK_LABEL,
      url: dashboardUrl,
    });
  }

  /**
   * Posts the "workflow succeeded" comment in Jira after the OpenWebUI upload.
   *
   * @param {string} issueKey -> Jira issue key.
   * @param {string|null} reporterAccountId -> Reporter accountId or null.
   * @param {string} dashboardUrl -> Deep link to the WebUI ticket page.
   * @returns {Promise<Object>} -> Jira API response.
   * @throws {Error} -> If the POST fails.
   */
  async function commentWorkflowSucceeded(issueKey, reporterAccountId, dashboardUrl) {
    log('commentWorkflowSucceeded called with: %o', { issueKey, hasMention: !!reporterAccountId });
    const message = reporterAccountId
      ? COMMENT_TEMPLATES.SUCCESS
      : COMMENT_TEMPLATES.SUCCESS_NO_MENTION;
    return addCommentWithMention(issueKey, reporterAccountId, message, {
      label: COMMENT_TEMPLATES.SUCCESS_LINK_LABEL,
      url: dashboardUrl,
    });
  }

  /**
   * Posts the "workflow failed" comment in Jira. Includes step number, step
   * name, and a short error message. Never includes a stacktrace.
   *
   * @param {string} issueKey -> Jira issue key.
   * @param {string|null} reporterAccountId -> Reporter accountId or null.
   * @param {string} dashboardUrl -> Deep link to the WebUI ticket page.
   * @param {number} stepNumber -> 1-based step number.
   * @param {string} stepName -> Localized step name (e.g. "OpenWebUI Upload").
   * @param {string} errorMessage -> Raw error message; will be truncated.
   * @returns {Promise<Object>} -> Jira API response.
   * @throws {Error} -> If the POST fails.
   */
  async function commentWorkflowFailed(
    issueKey,
    reporterAccountId,
    dashboardUrl,
    stepNumber,
    stepName,
    errorMessage,
  ) {
    log('commentWorkflowFailed called with: %o', {
      issueKey,
      stepNumber,
      stepName,
      hasMention: !!reporterAccountId,
    });
    const truncated = truncateError(errorMessage);
    const lead = reporterAccountId
      ? `leider gab es bei der Verarbeitung deines Tickets einen Fehler in Schritt ${stepNumber} (${stepName}): ${truncated}.`
      : `Leider gab es bei der Verarbeitung deines Tickets einen Fehler in Schritt ${stepNumber} (${stepName}): ${truncated}.`;
    return addCommentWithMention(issueKey, reporterAccountId, lead, {
      label: COMMENT_TEMPLATES.FAILURE_LINK_LABEL,
      url: dashboardUrl,
    });
  }

  /**
   * Downloads the binary content of a Jira attachment. The content URL is the
   * absolute URL Jira provides on the attachment object; it lives on the same
   * host as the configured base URL, so the axios instance's Basic-Auth header
   * still applies.
   *
   * @param {string} contentUrl -> Absolute attachment content URL.
   * @param {number} [maxBytes] -> Optional upper bound for the response/body size.
   * @returns {Promise<Buffer>} -> The raw attachment bytes.
   * @throws {Error} -> If the download fails or exceeds the size limit.
   */
  async function downloadAttachment(contentUrl, maxBytes = 0) {
    log('downloadAttachment called with: %o', { contentUrl, maxBytes });
    try {
      const options = { responseType: 'arraybuffer' };
      if (maxBytes > 0) {
        options.maxContentLength = maxBytes;
        options.maxBodyLength = maxBytes;
      }
      const resp = await getClient().get(contentUrl, options);
      return Buffer.from(resp.data);
    } catch (err) {
      console.error('[jiraService] downloadAttachment failed:', err.message);
      throw err;
    }
  }

  /**
   * Lightweight ping to detect Jira API availability and measure latency.
   *
   * @returns {Promise<Object>} -> { status: 'up'|'warn'|'down', latencyMs, statusLabel }
   */
  async function healthCheck() {
    log('healthCheck called');
    const start = Date.now();
    // Short-circuit with a clear status when Jira is not configured yet, instead
    // of letting axios throw a cryptic "Invalid URL" on an empty base URL.
    if (!settingsService.getJiraConfig().baseUrl) {
      return { status: 'down', latencyMs: 0, statusLabel: 'Nicht konfiguriert' };
    }
    try {
      await getClient().get('/rest/api/3/myself');
      const latencyMs = Date.now() - start;
      const status = latencyMs > 500 ? 'warn' : 'up';
      const statusLabel = status === 'warn' ? 'Erhöhte Latenz' : 'Verbunden';
      return { status, latencyMs, statusLabel };
    } catch (err) {
      console.warn('[jiraService] healthCheck failed:', err.message);
      return { status: 'down', latencyMs: Date.now() - start, statusLabel: 'Nicht erreichbar' };
    }
  }

  return {
    getIssue,
    listFields,
    getReporterAccountId,
    addCommentWithMention,
    addInaccuracyComment,
    getIssueTransitions,
    transitionIssue,
    commentTicketReceived,
    commentWorkflowSucceeded,
    commentWorkflowFailed,
    downloadAttachment,
    healthCheck,
  };
}

module.exports = { createJiraService };
