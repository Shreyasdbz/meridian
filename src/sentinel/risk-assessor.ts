// @meridian/sentinel — Risk assessor (Section 5.3.5)
// Independent risk level assessment per execution step.
// Classifies actions and detects divergence between Scout and Sentinel risk levels.

import type { ExecutionStep, RiskLevel } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Action type classification
// ---------------------------------------------------------------------------

/**
 * Classification of an execution step's action.
 * Maps to the 10 default risk policy categories (Section 5.3.5),
 * plus 'unknown' as a fail-safe for unclassifiable actions.
 */
export type ActionType =
  | 'read_files'
  | 'write_files'
  | 'delete_files'
  | 'network_get'
  | 'network_mutate'
  | 'shell_execute'
  | 'credential_usage'
  | 'financial_transaction'
  | 'send_message'
  | 'system_config'
  | 'unknown';

/**
 * Numeric ordering of risk levels for comparison and divergence detection.
 */
export const RISK_LEVEL_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Base risk level assigned to each action type.
 * Used for independent risk assessment when context is unavailable.
 */
const BASE_RISK_BY_ACTION: Record<ActionType, RiskLevel> = {
  read_files: 'low',
  write_files: 'medium',
  delete_files: 'high',
  network_get: 'low',
  network_mutate: 'high',
  shell_execute: 'critical',
  credential_usage: 'medium',
  financial_transaction: 'critical',
  send_message: 'high',
  system_config: 'critical',
  unknown: 'high', // fail-safe: unknown actions treated as high risk
};

// ---------------------------------------------------------------------------
// Divergence detection
// ---------------------------------------------------------------------------

/**
 * Risk divergence information when Scout's and Sentinel's independent
 * risk assessments differ by more than one level.
 * Logged as an anomaly for audit review (Section 5.3.2).
 */
export interface RiskDivergence {
  stepId: string;
  scoutRisk: RiskLevel;
  sentinelRisk: RiskLevel;
  difference: number;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Extract words from a name by splitting on hyphens, underscores,
 * and camelCase boundaries.
 */
function extractWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[-_]+/)
    .filter(Boolean);
}

function hasAnyWord(words: string[], targets: string[]): boolean {
  return words.some((w) => targets.includes(w));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an execution step into an action type based on its gear name,
 * action name, and parameters.
 *
 * Classification uses pattern matching in priority order:
 * 1. Shell execution (critical)
 * 2. Financial transactions (critical)
 * 3. System configuration (critical, write-like only)
 * 4. Credential/secret usage
 * 5. Message sending
 * 6. Network operations
 * 7. File operations
 * 8. Parameter-based hints (last resort)
 * 9. Unknown (fail-safe)
 */
export function classifyAction(step: ExecutionStep): ActionType {
  const gearWords = extractWords(step.gear);
  const actionWords = extractWords(step.action);
  const params = step.parameters;

  // 1. Shell execution — highest priority, always critical
  if (
    hasAnyWord(gearWords, ['shell', 'terminal', 'command', 'cmd', 'bash', 'sh']) ||
    (hasAnyWord(actionWords, ['execute', 'exec', 'spawn', 'shell']) &&
      !hasAnyWord(gearWords, ['sql', 'query', 'db', 'database']))
  ) {
    return 'shell_execute';
  }

  // 2. Financial transactions — critical risk
  if (
    hasAnyWord(gearWords, [
      'payment', 'finance', 'billing', 'stripe', 'paypal', 'bank', 'invoice',
    ]) ||
    hasAnyWord(actionWords, [
      'pay', 'charge', 'transfer', 'purchase', 'refund', 'subscribe',
      'debit', 'credit', 'withdraw', 'deposit',
    ])
  ) {
    return 'financial_transaction';
  }

  // 3. System configuration — critical risk (write-like actions only)
  if (
    (hasAnyWord(gearWords, ['config', 'settings', 'admin', 'setup']) &&
      !hasAnyWord(actionWords, ['read', 'get', 'list', 'show', 'view'])) ||
    hasAnyWord(actionWords, [
      'configure', 'install', 'uninstall', 'reset',
    ])
  ) {
    return 'system_config';
  }

  // 4. Credential/secret usage
  if (
    hasAnyWord(gearWords, [
      'credential', 'secret', 'vault', 'password', 'cert', 'auth',
    ]) ||
    hasAnyWord(actionWords, [
      'authenticate', 'authorize', 'decrypt', 'encrypt', 'login', 'logout',
    ])
  ) {
    return 'credential_usage';
  }

  // 5. Message sending — disambiguate from file/network operations
  if (
    hasAnyWord(gearWords, [
      'email', 'mail', 'chat', 'slack', 'discord', 'telegram',
      'sms', 'notification',
    ]) ||
    (hasAnyWord(actionWords, [
      'send', 'notify', 'broadcast', 'email', 'message',
      'reply', 'forward', 'publish',
    ]) &&
      !hasAnyWord(gearWords, [
        'file', 'fs', 'web', 'http', 'api', 'network', 'webhook',
      ]))
  ) {
    return 'send_message';
  }

  // 6. Network operations — check before file operations
  if (
    hasAnyWord(gearWords, [
      'web', 'http', 'https', 'api', 'fetch', 'request', 'net',
      'network', 'rest', 'graphql', 'curl', 'webhook',
    ]) ||
    hasAnyWord(actionWords, ['fetch', 'request', 'download', 'upload'])
  ) {
    const method =
      typeof params.method === 'string' ? params.method.toUpperCase() : '';

    const isReadAction = hasAnyWord(actionWords, [
      'get', 'fetch', 'download', 'head', 'options',
    ]);
    const isReadMethod =
      method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const isMutateMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    // Method parameter takes priority over action name
    if (isMutateMethod) {
      return 'network_mutate';
    }
    if (isReadMethod || isReadAction) {
      return 'network_get';
    }
    return 'network_mutate';
  }

  // 7. File operations
  if (
    hasAnyWord(gearWords, [
      'file', 'fs', 'filesystem', 'storage', 'disk', 'directory',
    ]) ||
    hasAnyWord(actionWords, [
      'read', 'write', 'mkdir', 'rmdir', 'unlink', 'copy', 'move',
      'rename', 'stat', 'exists', 'glob', 'save',
    ])
  ) {
    if (
      hasAnyWord(actionWords, [
        'delete', 'remove', 'rm', 'rmdir', 'unlink', 'trash', 'clean',
      ])
    ) {
      return 'delete_files';
    }
    if (
      hasAnyWord(actionWords, [
        'write', 'create', 'append', 'save', 'copy', 'move', 'rename',
        'mkdir', 'put',
      ])
    ) {
      return 'write_files';
    }
    return 'read_files';
  }

  // 8. Parameter-based hints (last resort)
  if (
    typeof params.amount === 'number' &&
    typeof params.currency === 'string'
  ) {
    return 'financial_transaction';
  }
  if (typeof params.url === 'string' || typeof params.uri === 'string') {
    return 'network_get';
  }

  return 'unknown';
}

/**
 * Independently assess the risk level of an execution step
 * based on its classified action type.
 */
export function assessStepRisk(step: ExecutionStep): RiskLevel {
  const actionType = classifyAction(step);
  return BASE_RISK_BY_ACTION[actionType];
}

/**
 * Check for risk divergence between Scout's declared risk level
 * and Sentinel's independent assessment. Returns divergence info
 * if the difference exceeds one level, null otherwise.
 *
 * Per Section 5.3.2: divergence of more than one level is logged
 * as an anomaly for audit review.
 */
export function checkRiskDivergence(
  stepId: string,
  scoutRisk: RiskLevel,
  sentinelRisk: RiskLevel,
): RiskDivergence | null {
  const scoutLevel = RISK_LEVEL_ORDER[scoutRisk];
  const sentinelLevel = RISK_LEVEL_ORDER[sentinelRisk];
  const difference = Math.abs(scoutLevel - sentinelLevel);

  if (difference > 1) {
    return { stepId, scoutRisk, sentinelRisk, difference };
  }

  return null;
}
