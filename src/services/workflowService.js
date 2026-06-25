'use strict';

const debug = require('debug');

const { generateMarkdown } = require('./markdownService');
const queries = require('../db/queries');
const socketService = require('./socketService');
const embeddingService = require('./embeddingService');
const {
  STEP_STATUS,
  TICKET_STATUS,
  TICKET_LIFECYCLE,
  ACTIVITY_KIND,
  WORKFLOW_STEPS,
  OPENWEBUI_MODE,
} = require('../constants');

const log = debug('knowflow:workflowService');

/**
 * Builds the public WebUI URL for a ticket, used in the Jira comment link.
 *
 * @param {string} publicBaseUrl -> Configured PUBLIC_BASE_URL.
 * @param {string} jiraId -> Issue key.
 * @returns {string} -> Deep link.
 */
function buildTicketUrl(publicBaseUrl, jiraId) {
  return `${publicBaseUrl.replace(/\/$/, '')}/?ticket=${encodeURIComponent(jiraId)}`;
}

/**
 * Logs an activity event in DB and emits the corresponding Socket.IO event.
 *
 * @param {Object} args -> Event fields.
 * @param {string} args.kind -> ACTIVITY_KIND value.
 * @param {string|null} args.jiraId -> Optional issue key.
 * @param {string} args.title -> Short title.
 * @param {string|null} [args.detail] -> Optional detail.
 * @param {string} [args.source] -> Source label.
 * @returns {Object} -> The inserted event row.
 */
function recordEvent(args) {
  const event = queries.insertEvent(args);
  socketService.emitActivityNew(event);
  return event;
}

/**
 * Emits the current workflow state for a ticket to all connected clients.
 *
 * @param {string} jiraId -> Issue key.
 * @returns {void}
 */
function broadcastWorkflowState(jiraId) {
  const run = queries.getWorkflowRun(jiraId);
  const ticket = queries.getTicket(jiraId);
  if (!run || !ticket) return;
  socketService.emitWorkflowUpdate({
    jiraId,
    overallStatus: ticket.overall_status,
    wf: [run.step_1_status, run.step_2_status, run.step_3_status],
    subs: [run.step_1_sub, run.step_2_sub, run.step_3_sub],
    error: run.error,
    updatedAt: ticket.updated_at,
  });
  socketService.emitTicketStatus({
    jiraId,
    overallStatus: ticket.overall_status,
    jiraStatus: ticket.jira_status,
  });
}

/**
 * Marks a step as work and emits the new state.
 *
 * @param {string} jiraId -> Issue key.
 * @param {number} stepIndex -> 0-based step index.
 * @param {string} sub -> WebUI sub-line.
 * @returns {void}
 */
function startStep(jiraId, stepIndex, sub) {
  log('startStep called with: %o', { jiraId, stepIndex, sub });
  queries.setStepStatus(jiraId, stepIndex, STEP_STATUS.WORK, sub);
  queries.setTicketOverallStatus(jiraId, TICKET_STATUS.WORK);
  broadcastWorkflowState(jiraId);
}

/**
 * Marks a step as done and emits the new state.
 *
 * @param {string} jiraId -> Issue key.
 * @param {number} stepIndex -> 0-based step index.
 * @param {string} sub -> WebUI sub-line describing the result.
 * @returns {void}
 */
function completeStep(jiraId, stepIndex, sub) {
  log('completeStep called with: %o', { jiraId, stepIndex });
  queries.setStepStatus(jiraId, stepIndex, STEP_STATUS.DONE, sub);
  broadcastWorkflowState(jiraId);
}

/**
 * Marks a step as failed, sets the overall status to err, finishes the run, and
 * records an activity event.
 *
 * @param {string} jiraId -> Issue key.
 * @param {number} stepIndex -> 0-based step index.
 * @param {Error} err -> The thrown error.
 * @returns {void}
 */
function failStep(jiraId, stepIndex, err) {
  log('failStep called with: %o', { jiraId, stepIndex, error: err?.message });
  queries.setStepStatus(jiraId, stepIndex, STEP_STATUS.ERR, err?.message ?? 'Unbekannter Fehler');
  queries.setTicketOverallStatus(jiraId, TICKET_STATUS.ERR);
  queries.finishWorkflowRun(jiraId, err?.message ?? 'Unbekannter Fehler');
  recordEvent({
    kind: ACTIVITY_KIND.ERR,
    jiraId,
    title: `Workflow-Schritt fehlgeschlagen: ${WORKFLOW_STEPS[stepIndex].label}`,
    detail: err?.message ?? 'Unbekannter Fehler',
    source: 'System',
  });
  broadcastWorkflowState(jiraId);
}

/**
 * Factory: returns the workflow service bound to its dependencies.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.jiraService -> Result of createJiraService.
 * @param {Object} deps.openwebuiService -> Result of createOpenWebUiService (multi-target).
 * @param {Object} deps.routingService -> Result of createRoutingService.
 * @param {Object} deps.attachmentService -> Result of createAttachmentService.
 * @param {Object} deps.settingsService -> The settings service.
 * @param {Object} deps.config -> Loaded app config (for publicBaseUrl).
 * @returns {Object} -> Service with handleIssueDone, handleIssueRework, retryTicket.
 */
function createWorkflowService({ jiraService, openwebuiService, routingService, attachmentService, settingsService, config }) {
  log('createWorkflowService called');

  /**
   * Wraps a Jira comment POST: catches any failure, logs it, and records a warn
   * event. The workflow must never be aborted by a failed comment.
   *
   * @param {Function} fn -> Async function that performs the comment POST.
   * @param {string} jiraId -> Issue key for activity logging.
   * @param {string} kind -> Short identifier for the comment kind (received|success|failed).
   * @returns {Promise<void>} -> Always resolves.
   */
  async function safePostComment(fn, jiraId, kind) {
    try {
      await fn();
    } catch (err) {
      console.error(
        `[workflowService] Jira-Kommentar (${kind}) konnte nicht geschrieben werden:`,
        err.message,
      );
      recordEvent({
        kind: ACTIVITY_KIND.WARN,
        jiraId,
        title: `Jira-Kommentar (${kind}) fehlgeschlagen`,
        detail: err.message,
        source: 'KnowFlow',
      });
    }
  }

  /**
   * Fails a step and posts a "workflow failed" comment in Jira. Centralized so
   * every error path produces the same artifacts.
   *
   * @param {string} jiraId -> Issue key.
   * @param {number} stepIndex -> 0-based step index.
   * @param {Error} err -> The thrown error.
   * @param {string|null} reporterAccountId -> Reporter accountId for the mention.
   * @returns {Promise<void>}
   */
  async function failStepAndComment(jiraId, stepIndex, err, reporterAccountId) {
    failStep(jiraId, stepIndex, err);
    const dashboardUrl = buildTicketUrl(config.publicBaseUrl, jiraId);
    const stepName = WORKFLOW_STEPS[stepIndex].label;
    await safePostComment(
      () =>
        jiraService.commentWorkflowFailed(
          jiraId,
          reporterAccountId,
          dashboardUrl,
          stepIndex + 1,
          stepName,
          err?.message ?? 'Unbekannter Fehler',
        ),
      jiraId,
      'failed',
    );
  }

  /**
   * Runs the three-step pipeline for a single issue and posts three lifecycle
   * comments in Jira (received, succeeded, failed) at the configured points.
   *
   * @param {string} issueKey -> Issue key.
   * @param {Object} [options] -> Options.
   * @param {boolean} [options.isRework=false] -> If true, update existing file instead of upload.
   * @param {Object} [options.webhookPayload] -> Optional webhook issue payload, used
   *   to read the reporter accountId before step 1 so the received-comment can
   *   mention the user even though the DB does not yet have it.
   * @returns {Promise<void>} -> Resolves when the pipeline finishes (success or failure).
   */
  async function runPipeline(issueKey, { isRework = false, webhookPayload = null } = {}) {
    log('runPipeline called with: %o', { issueKey, isRework, hasPayload: !!webhookPayload });

    // Ensure a placeholder ticket exists so workflow_runs.FK does not fail
    // on the very first run for a new issue key.
    const existing = queries.getTicket(issueKey);
    if (!existing) {
      queries.upsertTicket({
        jiraId: issueKey,
        projectKey: (issueKey.split('-')[0] || 'PROJ'),
        summary: issueKey,
        priority: null,
        assignee: null,
        reporter: null,
        reporterAccountId: null,
        jiraStatus: null,
        overallStatus: TICKET_STATUS.WORK,
      });
    }

    queries.resetWorkflowRun(issueKey);
    queries.setTicketOverallStatus(issueKey, TICKET_STATUS.WORK);
    broadcastWorkflowState(issueKey);

    // Resolve a best-effort reporterAccountId for the early "received" comment.
    // Priority: webhook payload (most up-to-date) > existing DB row.
    let reporterAccountId =
      webhookPayload?.fields?.reporter?.accountId
      ?? existing?.reporter_account_id
      ?? null;

    // Comment #1: "ticket received". Posted on every pipeline run (no dedup),
    // because a Rework -> Done cycle is a new processing pass.
    const dashboardUrl = buildTicketUrl(config.publicBaseUrl, issueKey);
    await safePostComment(
      () => jiraService.commentTicketReceived(issueKey, reporterAccountId, dashboardUrl),
      issueKey,
      'received',
    );

    let issue;
    let storedAttachments = [];
    // Step 1: load from Jira
    try {
      startStep(issueKey, 0, 'Lade Issue über Jira REST API...');
      issue = await jiraService.getIssue(issueKey);
      const commentCount = issue?.fields?.comment?.comments?.length || 0;

      // Sync attachments. A total failure must not abort the pipeline; per-file
      // problems (download errors, oversized files) are surfaced as warn events.
      let attachmentSub = '';
      try {
        const syncResult = await attachmentService.syncAttachments(issueKey, issue);
        storedAttachments = syncResult.attachments;
        attachmentSub = `, ${storedAttachments.length} Anhang/Anhänge`;
        for (const skip of syncResult.skipped) {
          recordEvent({
            kind: ACTIVITY_KIND.WARN,
            jiraId: issueKey,
            title: `Anhang übersprungen (zu groß): ${skip.filename}`,
            detail: `${skip.size} Bytes überschreiten das Limit`,
            source: 'KnowFlow',
          });
        }
        for (const errInfo of syncResult.errors) {
          recordEvent({
            kind: ACTIVITY_KIND.WARN,
            jiraId: issueKey,
            title: `Anhang-Download fehlgeschlagen: ${errInfo.filename}`,
            detail: errInfo.error,
            source: 'KnowFlow',
          });
        }
      } catch (attachErr) {
        console.error('[workflowService] syncAttachments failed:', attachErr.message);
        recordEvent({
          kind: ACTIVITY_KIND.WARN,
          jiraId: issueKey,
          title: 'Anhang-Synchronisierung fehlgeschlagen',
          detail: attachErr.message,
          source: 'KnowFlow',
        });
      }

      completeStep(issueKey, 0, `Issue geladen, ${commentCount} Kommentar(e)${attachmentSub}`);
      recordEvent({
        kind: ACTIVITY_KIND.INFO,
        jiraId: issueKey,
        title: 'Issue aus Jira geladen',
        detail: `${commentCount} Kommentar(e), Assignee=${issue?.fields?.assignee?.displayName || 'unbekannt'}`,
        source: 'KnowFlow',
      });
    } catch (err) {
      await failStepAndComment(issueKey, 0, err, reporterAccountId);
      return;
    }

    const projectKey = issue?.fields?.project?.key || (issueKey.split('-')[0] || 'PROJ');
    const summary = issue?.fields?.summary || issueKey;
    const priority = issue?.fields?.priority?.name || 'Mittel';
    const assignee = issue?.fields?.assignee?.displayName || null;
    const reporter = issue?.fields?.reporter?.displayName || null;
    // Prefer the fresh issue data over the early webhook payload from above.
    reporterAccountId = jiraService.getReporterAccountId(issue) ?? reporterAccountId;
    const jiraStatus = issue?.fields?.status?.name || null;

    queries.upsertTicket({
      jiraId: issueKey,
      projectKey,
      summary,
      priority,
      assignee,
      reporter,
      reporterAccountId,
      jiraStatus,
      overallStatus: TICKET_STATUS.WORK,
    });

    // Resolve which knowledge bases (OpenWebUI targets) and MCP connections this
    // ticket should flow into, based on the admin-defined routing rules evaluated
    // against the freshly loaded issue.
    const { targets, mcpConnectionIds, matchedRules, usedFallback } = routingService.resolveTargets(issue);
    if (targets.length === 0 && mcpConnectionIds.length === 0) {
      await failStepAndComment(
        issueKey,
        2,
        new Error('Keine Routing-Regel hat zugetroffen und kein Fallback-Ziel ist konfiguriert.'),
        reporterAccountId,
      );
      return;
    }

    // Persist the MCP connection assignments so the MCP servers can scope this
    // ticket's knowledge to the right connections.
    queries.replaceTicketMcpAssignments(issueKey, mcpConnectionIds);

    const targetNames = targets.map((t) => t.name);
    const routingLabel = usedFallback
      ? `Routing: Fallback-Ziel(e) verwendet (${targetNames.join(', ') || 'keine'})`
      : `Routing: ${matchedRules.join(', ')} -> ${targetNames.join(', ') || 'keine OpenWebUI-Ziele'}`;
    recordEvent({
      kind: ACTIVITY_KIND.INFO,
      jiraId: issueKey,
      title: routingLabel,
      detail: mcpConnectionIds.length ? `MCP-Verbindungen: ${mcpConnectionIds.join(', ')}` : null,
      source: 'KnowFlow',
    });

    // Step 2: save markdown (using the admin-configured field mappings; the
    // description and solution come from dedicated Jira fields, comments are
    // ignored).
    let markdown;
    try {
      startStep(issueKey, 1, 'Generiere Wissens-Markdown...');
      const attachmentLinks = storedAttachments.map((row) => ({
        filename: row.filename,
        mimeType: row.mime_type,
        size: row.size,
        url: `${config.publicBaseUrl.replace(/\/$/, '')}/api/attachments/${encodeURIComponent(issueKey)}/${encodeURIComponent(row.jira_attachment_id)}`,
      }));
      markdown = generateMarkdown(
        issue,
        settingsService.getFieldMappings(),
        settingsService.getMarkdownOptions(),
        targetNames,
        attachmentLinks,
      );
      queries.updateTicketMarkdown(issueKey, markdown);
      const sizeKb = (Buffer.byteLength(markdown, 'utf8') / 1024).toFixed(1);
      completeStep(issueKey, 1, `${sizeKb} KB nach SQLite geschrieben`);
      recordEvent({
        kind: ACTIVITY_KIND.INFO,
        jiraId: issueKey,
        title: 'Markdown in Datenbank gespeichert',
        detail: `${sizeKb} KB`,
        source: 'KnowFlow',
      });
    } catch (err) {
      await failStepAndComment(issueKey, 1, err, reporterAccountId);
      return;
    }

    // Optional RAG layer: embed the markdown for semantic search. This is
    // best-effort and deliberately not a workflow step — a failing embedding
    // (e.g. Ollama down) must never fail the ticket. The ticket is marked
    // 'failed' so the next reindex retries it, and search degrades to keyword.
    if (embeddingService.isEnabled()) {
      try {
        const res = await embeddingService.embedTicket(issueKey, markdown);
        recordEvent({
          kind: ACTIVITY_KIND.INFO,
          jiraId: issueKey,
          title: 'Embedding für semantische Suche erzeugt',
          detail: `${res.model} (${res.dim} Dimensionen)`,
          source: 'KnowFlow',
        });
      } catch (err) {
        queries.setTicketEmbeddingStatus(issueKey, 'failed');
        recordEvent({
          kind: ACTIVITY_KIND.WARN,
          jiraId: issueKey,
          title: 'Embedding fehlgeschlagen (Suche nutzt Stichwort-Fallback)',
          detail: err.message,
          source: 'KnowFlow',
        });
      }
    }

    // Step 3: upload (or update) in every resolved knowledge base. Per target we
    // check ticket_uploads: an existing record means update, otherwise upload +
    // add-to-knowledge. This naturally handles rework (overwrite) and newly
    // added targets (fresh upload) without a global rework flag.
    try {
      if (targets.length === 0) {
        // MCP-only routing: no OpenWebUI targets. The knowledge is already in the
        // DB (step 2) and scoped via the MCP assignments above.
        completeStep(issueKey, 2, 'Keine OpenWebUI-Ziele, nur MCP');
        recordEvent({
          kind: ACTIVITY_KIND.OK,
          jiraId: issueKey,
          title: 'Wissen nur für MCP bereitgestellt',
          detail: `MCP-Verbindungen: ${mcpConnectionIds.join(', ')}`,
          source: 'System',
        });
      } else {
        startStep(issueKey, 2, `Übertrage an ${targets.length} Wissensbasis(en)...`);
        let firstUuid = null;
        for (const target of targets) {
          const existingUpload = queries.getTicketUpload(issueKey, target.id);
          if (existingUpload?.owui_uuid) {
            const res = await openwebuiService.updateFileContent(existingUpload.owui_uuid, markdown, target);
            queries.upsertTicketUpload(issueKey, target.id, res.id);
            if (!firstUuid) firstUuid = res.id;
          } else {
            const uploadRes = await openwebuiService.uploadFile(markdown, issueKey, target);
            await openwebuiService.addToKnowledge(uploadRes.id, target);
            queries.upsertTicketUpload(issueKey, target.id, uploadRes.id);
            if (!firstUuid) firstUuid = uploadRes.id;
          }
        }
        // Keep tickets.openwebui_uuid populated (first target) so the existing
        // Wissensbasis view keeps working.
        if (firstUuid) queries.setTicketOpenWebUiUuid(issueKey, firstUuid);
        completeStep(issueKey, 2, `${targets.length} Wissensbasis(en) aktualisiert`);
        recordEvent({
          kind: ACTIVITY_KIND.OK,
          jiraId: issueKey,
          title: 'Wissen an OpenWebUI gesendet',
          detail: `${targets.length} Ziel(e): ${targets.map((t) => t.name).join(', ')}`,
          source: 'System',
        });
      }
    } catch (err) {
      await failStepAndComment(issueKey, 2, err, reporterAccountId);
      return;
    }

    // Final state: done
    queries.setTicketOverallStatus(issueKey, TICKET_STATUS.DONE);
    queries.finishWorkflowRun(issueKey, null);
    broadcastWorkflowState(issueKey);

    // Comment #2: "workflow succeeded". Replaces the old generic comment.
    const successUrl = buildTicketUrl(config.publicBaseUrl, issueKey);
    await safePostComment(
      async () => {
        await jiraService.commentWorkflowSucceeded(issueKey, reporterAccountId, successUrl);
        recordEvent({
          kind: ACTIVITY_KIND.OK,
          jiraId: issueKey,
          title: 'Jira-Erfolgskommentar geschrieben',
          detail: `Mention an Reporter, Link auf ${successUrl}`,
          source: 'KnowFlow',
        });
      },
      issueKey,
      'success',
    );
  }

  /**
   * Public entry point for a Done-transition. Triggered from the webhook route.
   * Decides whether to do an initial upload or a rework update based on prior state.
   *
   * @param {string} issueKey -> Issue key.
   * @param {Object} [webhookPayload] -> Optional issue payload from the webhook.
   *   Forwarded into runPipeline so the early "received" comment can mention
   *   the reporter even before step 1 has fetched the full issue.
   * @returns {Promise<void>}
   */
  async function handleIssueDone(issueKey, webhookPayload = null) {
    log('handleIssueDone called with: %o', { issueKey, hasPayload: !!webhookPayload });
    const existing = queries.getTicket(issueKey);
    if (existing && existing.lifecycle && existing.lifecycle !== TICKET_LIFECYCLE.ACTIVE) {
      const label = existing.lifecycle === TICKET_LIFECYCLE.DELETED ? 'gelöscht' : 'veraltet';
      recordEvent({
        kind: ACTIVITY_KIND.INFO,
        jiraId: issueKey,
        title: `Webhook ignoriert: ${issueKey} ist ${label}`,
        detail: 'Pipeline läuft erst nach einer Reaktivierung wieder.',
        source: 'Jira',
      });
      return;
    }
    const wasRework =
      existing?.overall_status === TICKET_STATUS.REWORK && existing?.openwebui_uuid;
    recordEvent({
      kind: ACTIVITY_KIND.INFO,
      jiraId: issueKey,
      title: wasRework
        ? `${issueKey} ist wieder Done - Workflow aktualisiert vorhandene Datei`
        : `${issueKey} ist auf Done gewechselt - Workflow startet`,
      detail: null,
      source: 'Jira',
    });
    await runPipeline(issueKey, { isRework: !!wasRework, webhookPayload });
  }

  /**
   * Public entry point when the issue moves into a rework status. The ticket is
   * marked as "rework" so the dashboard shows the right badge; the actual file
   * in Open WebUI is only overwritten when the issue moves back to Done.
   *
   * @param {string} issueKey -> Issue key.
   * @param {Object} [issuePayload] -> Optional partial issue payload from the webhook.
   * @returns {Promise<void>}
   */
  async function handleIssueRework(issueKey, issuePayload = null) {
    log('handleIssueRework called with: %o', { issueKey });
    const existingTicket = queries.getTicket(issueKey);
    if (existingTicket && existingTicket.lifecycle && existingTicket.lifecycle !== TICKET_LIFECYCLE.ACTIVE) {
      const label = existingTicket.lifecycle === TICKET_LIFECYCLE.DELETED ? 'gelöscht' : 'veraltet';
      recordEvent({
        kind: ACTIVITY_KIND.INFO,
        jiraId: issueKey,
        title: `Webhook ignoriert: ${issueKey} ist ${label}`,
        detail: 'Pipeline läuft erst nach einer Reaktivierung wieder.',
        source: 'Jira',
      });
      return;
    }
    try {
      const issue = issuePayload || (await jiraService.getIssue(issueKey));
      const projectKey =
        issue?.fields?.project?.key || (issueKey.split('-')[0] || 'PROJ');
      queries.upsertTicket({
        jiraId: issueKey,
        projectKey,
        summary: issue?.fields?.summary || issueKey,
        priority: issue?.fields?.priority?.name || null,
        assignee: issue?.fields?.assignee?.displayName || null,
        reporter: issue?.fields?.reporter?.displayName || null,
        reporterAccountId: jiraService.getReporterAccountId(issue),
        jiraStatus: issue?.fields?.status?.name || null,
        overallStatus: TICKET_STATUS.REWORK,
      });
      recordEvent({
        kind: ACTIVITY_KIND.REWORK,
        jiraId: issueKey,
        title: `${issueKey} wurde auf Überarbeiten gesetzt`,
        detail: 'Wissen wird beim nächsten Done überschrieben.',
        source: 'Jira',
      });
      broadcastWorkflowState(issueKey);
    } catch (err) {
      console.error('[workflowService] handleIssueRework failed:', err.message);
      recordEvent({
        kind: ACTIVITY_KIND.ERR,
        jiraId: issueKey,
        title: `Rework-Verarbeitung fehlgeschlagen für ${issueKey}`,
        detail: err.message,
        source: 'System',
      });
    }
  }

  /**
   * Retries the full pipeline for an existing ticket.
   *
   * @param {string} issueKey -> Issue key.
   * @returns {Promise<void>}
   */
  async function retryTicket(issueKey) {
    log('retryTicket called with: %o', { issueKey });
    const existing = queries.getTicket(issueKey);
    const isRework =
      existing?.overall_status === TICKET_STATUS.REWORK && existing?.openwebui_uuid;
    recordEvent({
      kind: ACTIVITY_KIND.INFO,
      jiraId: issueKey,
      title: `Manueller Retry für ${issueKey}`,
      detail: null,
      source: 'WebUI',
    });
    await runPipeline(issueKey, { isRework });
  }

  /**
   * Runs a fully self-contained, simulated version of the three-step pipeline.
   * Only used by the UI debug mode (UI_DEBUG=true) so a presenter can show how
   * the dashboard reacts to a transfer that runs slowly or aborts, without
   * touching the real Jira or Open WebUI APIs.
   *
   * Unlike runPipeline, this never calls jiraService and never posts Jira
   * comments. Steps 1 and 2 are pure simulation (delay + DB write). On a
   * successful step 3 a dummy Open WebUI file is created when running in dummy
   * mode, so the Wissensbasis view also updates realistically.
   *
   * @param {Object} [options] -> Simulation options.
   * @param {string|null} [options.jiraId] -> Ticket key to use; a DEMO key is
   *   generated when omitted.
   * @param {string} [options.speed='normal'] -> 'fast' | 'normal' | 'slow';
   *   controls the per-step delay.
   * @param {number|null} [options.failAtStep=null] -> 0-based step index that
   *   should fail (0..2), or null for a successful run.
   * @param {string|null} [options.errorMessage=null] -> Custom error text for
   *   the simulated failure; a default per-step message is used when omitted.
   * @returns {Promise<Object>} -> Result descriptor { jiraId, status, failedStep }.
   */
  async function simulateTransfer({
    jiraId = null,
    speed = 'normal',
    failAtStep = null,
    errorMessage = null,
  } = {}) {
    log('simulateTransfer called with: %o', { jiraId, speed, failAtStep });

    const SPEED_MS = { fast: 250, normal: 1300, slow: 3500 };
    const stepDelay = SPEED_MS[speed] ?? SPEED_MS.normal;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Use the provided key, or build a stable-looking demo key. We avoid
    // Date/random ambiguity by deriving the suffix from the current ticket count.
    const key = jiraId || `DEMO-${1000 + (Date.now() % 9000)}`;

    queries.upsertTicket({
      jiraId: key,
      projectKey: key.split('-')[0] || 'DEMO',
      summary: `Debug-Simulation ${key}`,
      priority: 'Mittel',
      assignee: 'Demo Bot',
      reporter: 'Presenter',
      reporterAccountId: null,
      jiraStatus: 'Done',
      overallStatus: TICKET_STATUS.WORK,
    });
    queries.resetWorkflowRun(key);
    queries.setTicketOverallStatus(key, TICKET_STATUS.WORK);
    broadcastWorkflowState(key);

    recordEvent({
      kind: ACTIVITY_KIND.INFO,
      jiraId: key,
      title: `Debug-Simulation gestartet (Tempo: ${speed}${failAtStep != null ? `, Abbruch in Schritt ${failAtStep + 1}` : ''})`,
      detail: null,
      source: 'Debug',
    });

    const subs = [
      'Lade Issue über Jira REST API...',
      'Generiere Wissens-Markdown...',
      'Lade Datei zu OpenWebUI hoch...',
    ];
    const defaultErrors = [
      'Jira API nicht erreichbar: connect ECONNREFUSED [Simulation]',
      'Markdown-Generierung fehlgeschlagen: unerwartetes Feld [Simulation]',
      'OpenWebUI-Service nicht erreichbar: timeout of 15000ms exceeded [Simulation]',
    ];

    /**
     * Records the simulated failure for a step and returns the result shape.
     *
     * @param {number} idx -> 0-based step index that failed.
     * @returns {Object} -> Result descriptor for the failed run.
     */
    function fail(idx) {
      failStep(key, idx, new Error(errorMessage || defaultErrors[idx]));
      return { jiraId: key, status: 'err', failedStep: idx };
    }

    // Step 1: load from Jira (simulated)
    startStep(key, 0, subs[0]);
    await delay(stepDelay);
    if (failAtStep === 0) return fail(0);
    completeStep(key, 0, 'Issue geladen, 3 Kommentar(e)');

    // Step 2: generate + persist markdown
    startStep(key, 1, subs[1]);
    await delay(stepDelay);
    if (failAtStep === 1) return fail(1);
    const markdown = `# ${key}\n\n> Simuliertes Wissensdokument (UI-Debug-Modus)\n\n`
      + `- **Priorität:** Mittel\n- **Quelle:** Debug-Simulation\n\n`
      + `## Zusammenfassung\n\nDieses Dokument wurde künstlich für eine Präsentation `
      + `erzeugt und stammt nicht aus einem echten Jira-Ticket.\n`;
    queries.updateTicketMarkdown(key, markdown);
    const sizeKb = (Buffer.byteLength(markdown, 'utf8') / 1024).toFixed(1);
    completeStep(key, 1, `${sizeKb} KB nach SQLite geschrieben`);

    // Step 3: upload to Open WebUI (real dummy upload in dummy mode, else simulated)
    startStep(key, 2, subs[2]);
    await delay(stepDelay);
    if (failAtStep === 2) return fail(2);
    let uuid = null;
    if (settingsService.getOpenWebUiMode() === OPENWEBUI_MODE.DUMMY) {
      try {
        // In dummy mode the target is ignored, but pass the first fallback
        // target (if any) so the call shape matches real mode.
        const fallbackTargets = settingsService.getTargetsByIds(settingsService.getFallbackTargetIds());
        const target = fallbackTargets[0] || { id: 'demo', name: 'Demo' };
        const uploadRes = await openwebuiService.uploadFile(markdown, key, target);
        uuid = uploadRes.id;
        queries.setTicketOpenWebUiUuid(key, uuid);
        await openwebuiService.addToKnowledge(uuid, target);
      } catch (err) {
        log('simulateTransfer dummy upload failed (ignored): %s', err.message);
      }
    }
    completeStep(key, 2, uuid ? `UUID ${uuid} hinzugefügt` : 'Upload simuliert');

    queries.setTicketOverallStatus(key, TICKET_STATUS.DONE);
    queries.finishWorkflowRun(key, null);
    broadcastWorkflowState(key);

    recordEvent({
      kind: ACTIVITY_KIND.OK,
      jiraId: key,
      title: 'Debug-Simulation erfolgreich abgeschlossen',
      detail: `Ticket ${key} durchlief alle drei Schritte`,
      source: 'Debug',
    });

    return { jiraId: key, status: 'done', failedStep: null };
  }

  return { handleIssueDone, handleIssueRework, retryTicket, simulateTransfer };
}

module.exports = { createWorkflowService };
