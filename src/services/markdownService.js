'use strict';

const debug = require('debug');

const { DEFAULT_MARKDOWN_OPTIONS, DEFAULT_FIELD_MAPPINGS } = require('../constants');

const log = debug('knowflow:markdownService');

const ADF_NEWLINE = '\n';

/**
 * Recursively flattens an Atlassian Document Format (ADF) node tree into plain text.
 * This is a lightweight extractor sufficient for a PoC: paragraphs, lists, headings,
 * code blocks, and inline text are preserved. Other node types fall through.
 *
 * @param {Object|undefined} node -> ADF node.
 * @returns {string} -> Plain-text rendering.
 */
function adfToPlainText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;

  if (Array.isArray(node)) {
    return node.map(adfToPlainText).join('');
  }

  const { type } = node;

  if (type === 'text') {
    return node.text || '';
  }

  const childText = node.content ? adfToPlainText(node.content) : '';

  switch (type) {
    case 'doc':
      return childText;
    case 'paragraph':
      return childText + ADF_NEWLINE + ADF_NEWLINE;
    case 'heading': {
      const level = node.attrs?.level || 2;
      return `${'#'.repeat(level)} ${childText}${ADF_NEWLINE}${ADF_NEWLINE}`;
    }
    case 'bulletList':
      return childText;
    case 'orderedList':
      return childText;
    case 'listItem':
      return `- ${childText.trim()}${ADF_NEWLINE}`;
    case 'codeBlock':
      return `\`\`\`${ADF_NEWLINE}${childText}${ADF_NEWLINE}\`\`\`${ADF_NEWLINE}${ADF_NEWLINE}`;
    case 'hardBreak':
      return ADF_NEWLINE;
    case 'rule':
      return `${ADF_NEWLINE}---${ADF_NEWLINE}`;
    default:
      return childText;
  }
}

/**
 * Coerces a Jira description field (which can be a string or an ADF document)
 * into plain text. Falls back to an empty string for null/undefined.
 *
 * @param {Object|string|null|undefined} description -> Jira description field.
 * @returns {string} -> Plain-text body.
 */
function descriptionToText(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  return adfToPlainText(description).trim();
}

/**
 * Normalizes any Jira field value into a flat array of non-empty strings.
 * Handles strings, numbers, ADF documents, select options ({ value }),
 * named entities ({ name }), users ({ displayName }), and arrays thereof
 * (multi-select fields, labels).
 *
 * @param {*} raw -> Raw Jira field value.
 * @returns {string[]} -> Flat list of string values.
 */
function normalizeToStrings(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? [t] : [];
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return [String(raw)];
  }
  if (Array.isArray(raw)) {
    return raw.flatMap(normalizeToStrings);
  }
  if (typeof raw === 'object') {
    if (raw.type === 'doc') {
      const t = adfToPlainText(raw).trim();
      return t ? [t] : [];
    }
    if (raw.value != null) return [String(raw.value)];
    if (raw.name != null) return [String(raw.name)];
    if (raw.displayName != null) return [String(raw.displayName)];
  }
  return [];
}

/**
 * Returns the array of string values for a mapped Jira field id. Used by the
 * routing engine and the metadata section.
 *
 * @param {Object} issue -> Jira issue payload.
 * @param {string} fieldId -> Jira field id (e.g. 'labels' or 'customfield_10050').
 * @returns {string[]} -> Values.
 */
function extractFieldValues(issue, fieldId) {
  if (!fieldId) return [];
  return normalizeToStrings(issue?.fields?.[fieldId]);
}

/**
 * Returns the full rich-text/plain-text content for a mapped Jira field id.
 * Rich-text (ADF) fields are flattened; multi-value fields are joined.
 *
 * @param {Object} issue -> Jira issue payload.
 * @param {string} fieldId -> Jira field id.
 * @returns {string} -> Text content.
 */
function extractFieldText(issue, fieldId) {
  if (!fieldId) return '';
  const raw = issue?.fields?.[fieldId];
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (raw.type === 'doc') return descriptionToText(raw);
  return extractFieldValues(issue, fieldId).join(', ');
}

/**
 * Formats a byte count into a short human-readable string (B, KB, MB).
 *
 * @param {number} bytes -> Size in bytes.
 * @returns {string} -> Human-readable size.
 */
function humanizeBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Generates a knowledge markdown document from a Jira issue, using the
 * admin-configured field mappings. The description and solution come from
 * dedicated Jira fields and are rendered as clearly separated sections.
 * Jira comments are deliberately ignored.
 *
 * Layout:
 *   # <Summary>
 *   <!-- jira-id: KEY | priorität: NAME | ziele: BotA, BotB -->
 *
 *   ## Beschreibung
 *   <description field>
 *
 *   ## Lösung
 *   <solution field>
 *
 *   ## Hinweis            (optional)
 *   ## Metadaten          (category + labels as tags, optional)
 *
 * @param {Object} issue -> Jira issue payload from jiraService.getIssue().
 * @param {Object} [fieldMappings] -> logical-field -> Jira-field-id mapping.
 * @param {Object} [options] -> Markdown template options.
 * @param {string[]} [targetNames] -> Resolved target names, for the meta comment.
 * @param {Object[]} [attachments] -> Attachment link objects ({ filename, mimeType, size, url }).
 * @returns {string} -> Markdown text ready for storage and upload.
 */
function generateMarkdown(issue, fieldMappings = {}, options = {}, targetNames = [], attachments = []) {
  log('generateMarkdown called with: %o', { jiraId: issue?.key });

  const opts = { ...DEFAULT_MARKDOWN_OPTIONS, ...options };
  const fm = { ...DEFAULT_FIELD_MAPPINGS, ...fieldMappings };

  const summary = issue?.fields?.summary || 'Unbekanntes Ticket';
  const priority = issue?.fields?.priority?.name || 'Mittel';
  const key = issue?.key || 'UNKNOWN';

  const description = extractFieldText(issue, fm.description).trim();
  const solution = fm.solution ? extractFieldText(issue, fm.solution).trim() : '';
  const hint = fm.hint ? extractFieldText(issue, fm.hint).trim() : '';
  const category = fm.category ? extractFieldValues(issue, fm.category) : [];
  const labels = fm.label ? extractFieldValues(issue, fm.label) : [];

  const metaParts = [`jira-id: ${key}`, `priorität: ${priority}`];
  if (Array.isArray(targetNames) && targetNames.length) {
    metaParts.push(`ziele: ${targetNames.join(', ')}`);
  }

  const lines = [];
  lines.push(`# ${summary}`);
  lines.push(`<!-- ${metaParts.join(' | ')} -->`);
  lines.push('');
  lines.push(`## ${opts.descriptionHeading}`);
  lines.push(description || '_Keine Beschreibung vorhanden._');
  lines.push('');
  lines.push(`## ${opts.solutionHeading}`);
  lines.push(solution || '_Keine Lösung dokumentiert._');
  lines.push('');

  if (opts.includeHint && hint) {
    lines.push(`## ${opts.hintHeading}`);
    lines.push(hint);
    lines.push('');
  }

  if (opts.includeMetadata) {
    const tags = [...category, ...labels].filter(Boolean);
    if (tags.length) {
      lines.push(`## ${opts.metadataHeading}`);
      lines.push(tags.map((t) => '`' + t + '`').join(' '));
      lines.push('');
    }
  }

  if (opts.includeAttachments !== false && Array.isArray(attachments) && attachments.length) {
    lines.push(`## ${opts.attachmentsHeading}`);
    for (const att of attachments) {
      const meta = [humanizeBytes(att.size)];
      if (att.mimeType) meta.push(att.mimeType);
      lines.push(`- [${att.filename}](${att.url}) (${meta.join(', ')})`);
    }
    lines.push('');
  }

  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  log('generateMarkdown produced: %o', { jiraId: issue?.key, bytes: Buffer.byteLength(out, 'utf8') });
  return out;
}

module.exports = {
  generateMarkdown,
  adfToPlainText,
  descriptionToText,
  extractFieldValues,
  extractFieldText,
};
