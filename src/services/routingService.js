'use strict';

const debug = require('debug');

const { extractFieldValues } = require('./markdownService');

const log = debug('knowflow:routingService');

/**
 * Evaluates a single rule condition against an issue.
 *
 * A condition is { field: <logical field key>, operator, value }. The logical
 * field is resolved to a concrete Jira field id via the field mappings, then
 * the issue's value(s) for that field are compared.
 *
 * @param {Object} condition -> { field, operator, value }.
 * @param {Object} issue -> Jira issue payload.
 * @param {Object} fieldMappings -> logical-field -> Jira-field-id mapping.
 * @returns {boolean} -> True if the condition matches.
 */
function evaluateCondition(condition, issue, fieldMappings) {
  const fieldId = fieldMappings[condition.field];
  if (!fieldId) return false;

  const values = extractFieldValues(issue, fieldId).map((v) => v.toLowerCase());
  const target = String(condition.value ?? '').trim().toLowerCase();

  switch (condition.operator) {
    case 'exists':
      return values.length > 0;
    case 'equals':
      return values.some((v) => v === target);
    case 'contains':
      return values.some((v) => v.includes(target));
    case 'in': {
      const allowed = target.split(',').map((s) => s.trim()).filter(Boolean);
      return values.some((v) => allowed.includes(v));
    }
    default:
      return false;
  }
}

/**
 * Returns true if all conditions of a rule match (logical AND). A rule with no
 * conditions never matches (avoids accidental catch-all rules).
 *
 * The optional ignore conditions act as an exclusion filter with the same
 * "all must match" semantics as the positive conditions: when every ignore
 * condition matches (and there is at least one), the rule is suppressed for
 * this issue even if its positive conditions matched. This lets an admin route
 * broadly (e.g. "everything") yet carve out specific tickets by tag/label.
 *
 * @param {Object} rule -> Rule descriptor with a conditions (and optional ignoreConditions) array.
 * @param {Object} issue -> Jira issue payload.
 * @param {Object} fieldMappings -> Field mappings.
 * @returns {boolean} -> True if the rule matches.
 */
function ruleMatches(rule, issue, fieldMappings) {
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return false;
  if (!rule.conditions.every((c) => evaluateCondition(c, issue, fieldMappings))) return false;

  const ignore = Array.isArray(rule.ignoreConditions) ? rule.ignoreConditions : [];
  if (ignore.length > 0 && ignore.every((c) => evaluateCondition(c, issue, fieldMappings))) {
    return false;
  }
  return true;
}

/**
 * Factory: returns a routing service bound to the settings store.
 *
 * @param {Object} settingsService -> The settings service.
 * @returns {Object} -> Service with resolveTargets.
 */
function createRoutingService(settingsService) {
  log('createRoutingService called');

  /**
   * Resolves the knowledge-base targets a ticket should flow into, by evaluating
   * the admin-defined routing rules against the issue. When no enabled rule
   * matches, the configured fallback targets are used.
   *
   * @param {Object} issue -> Jira issue payload (must include custom fields).
   * @returns {{targets: Object[], mcpConnectionIds: string[], matchedRules: string[], usedFallback: boolean}}
   *   -> Resolved enabled targets, deduped MCP connection ids, names of matched
   *   rules, and whether the OpenWebUI fallback was used.
   */
  function resolveTargets(issue) {
    log('resolveTargets called with: %o', { jiraId: issue?.key });
    const fieldMappings = settingsService.getFieldMappings();
    const rules = settingsService.listRules().filter((r) => r.enabled);

    const targetIds = [];
    const mcpConnectionIds = [];
    const matchedRules = [];
    for (const rule of rules) {
      if (ruleMatches(rule, issue, fieldMappings)) {
        matchedRules.push(rule.name);
        for (const id of rule.targetIds) {
          if (!targetIds.includes(id)) targetIds.push(id);
        }
        for (const id of rule.mcpIds || []) {
          if (!mcpConnectionIds.includes(id)) mcpConnectionIds.push(id);
        }
      }
    }

    // Fallback applies only to OpenWebUI targets. MCP connections are opt-in via
    // explicit rules; there is no MCP fallback.
    let usedFallback = false;
    let ids = targetIds;
    if (ids.length === 0) {
      usedFallback = true;
      ids = settingsService.getFallbackTargetIds();
    }

    const targets = settingsService.getTargetsByIds(ids);
    return { targets, mcpConnectionIds, matchedRules, usedFallback };
  }

  return { resolveTargets };
}

module.exports = { createRoutingService, evaluateCondition, ruleMatches };
