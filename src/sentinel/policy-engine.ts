// @meridian/sentinel — Policy engine (Section 5.3.5)
// Deterministic policy evaluation against execution plans.
// Evaluates each step against default risk policies, supports user-customizable
// policies (stricter only), hard floor policies, and composite risk detection.

import type {
  ExecutionPlan,
  ExecutionStep,
  Logger,
  RiskLevel,
  StepValidation,
  StepValidationVerdict,
  ValidationResult,
  ValidationVerdict,
} from '@meridian/shared';
import { generateId } from '@meridian/shared';

import {
  type ActionType,
  type RiskDivergence,
  RISK_LEVEL_ORDER,
  assessStepRisk,
  checkRiskDivergence,
  classifyAction,
} from './risk-assessor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyEngineConfig {
  /** Allowed workspace path for file operations. */
  workspacePath: string;
  /** Domains pre-approved for network GET requests. */
  allowlistedDomains: string[];
  /** User policy overrides (can only be stricter than defaults). */
  userPolicies?: UserPolicyOverride[];
  /**
   * Maximum transaction amount in USD.
   * Transactions exceeding this are rejected outright.
   */
  maxTransactionAmountUsd?: number;
}

export interface UserPolicyOverride {
  actionType: ActionType;
  verdict: StepValidationVerdict;
}

/** Internal result from evaluating a single step's policy. */
interface StepPolicyResult {
  verdict: StepValidationVerdict;
  category: string;
  reasoning: string;
  riskLevel: RiskLevel;
}

/** Composite risk pattern definition. */
interface CompositeRiskPattern {
  name: string;
  detect: (classifications: Map<string, ActionType>) => boolean;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard floor action types — verdict is always `needs_user_approval` at minimum.
 * Cannot be weakened by any user policy override.
 */
export const HARD_FLOOR_ACTIONS: ReadonlySet<ActionType> = new Set([
  'delete_files',
  'shell_execute',
  'financial_transaction',
  'system_config',
]);

/**
 * Verdict strictness ordering for comparing user overrides.
 * Higher number = stricter.
 */
const VERDICT_STRICTNESS: Record<StepValidationVerdict, number> = {
  approved: 0,
  needs_user_approval: 1,
  rejected: 2,
};

// ---------------------------------------------------------------------------
// Composite risk patterns
// ---------------------------------------------------------------------------

const COMPOSITE_PATTERNS: CompositeRiskPattern[] = [
  {
    name: 'credential_exfiltration',
    detect: (cls) => {
      const types = [...cls.values()];
      return (
        types.includes('credential_usage') &&
        (types.includes('network_get') || types.includes('network_mutate'))
      );
    },
    reasoning:
      'Credential access combined with network request indicates ' +
      'potential data exfiltration',
  },
  {
    name: 'data_leak',
    detect: (cls) => {
      const types = [...cls.values()];
      return types.includes('read_files') && types.includes('send_message');
    },
    reasoning:
      'File read combined with message sending indicates potential data leak',
  },
  {
    name: 'mass_deletion',
    detect: (cls) => {
      const types = [...cls.values()];
      return types.filter((t) => t === 'delete_files').length >= 3;
    },
    reasoning: 'Multiple file deletion steps indicate mass destruction risk',
  },
  {
    name: 'file_exfiltration',
    detect: (cls) => {
      const types = [...cls.values()];
      return (
        types.includes('read_files') &&
        (types.includes('network_get') || types.includes('network_mutate'))
      );
    },
    reasoning:
      'File read combined with network request indicates potential ' +
      'file exfiltration',
  },
];

// ---------------------------------------------------------------------------
// Path and domain helpers
// ---------------------------------------------------------------------------

/**
 * Extract file paths from step parameters by checking common parameter names.
 */
function extractPaths(params: Record<string, unknown>): string[] {
  const pathKeys = [
    'path', 'filePath', 'file_path', 'file', 'directory', 'dir',
    'destination', 'output', 'target', 'source', 'src', 'dest',
  ];
  const paths: string[] = [];

  for (const key of pathKeys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) {
      paths.push(value);
    }
  }

  const arrayKeys = ['paths', 'files', 'directories'];
  for (const key of arrayKeys) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) {
          paths.push(item);
        }
      }
    }
  }

  return paths;
}

/**
 * Normalize a file path by resolving `.` and `..` segments.
 * Prevents path traversal attacks (e.g., `/workspace/../etc/passwd`).
 *
 * IMPORTANT: This function always returns an absolute path (prefixed with `/`).
 * It must only be called on absolute paths — callers must reject relative paths
 * before invoking this function. See `isWithinWorkspace` which enforces this.
 */
function normalizePath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return '/' + resolved.join('/');
}

/**
 * Check if all extracted paths are within the workspace directory.
 * Relative paths cannot be verified and are treated as outside workspace (fail-safe).
 */
function isWithinWorkspace(
  paths: string[],
  workspacePath: string,
): boolean {
  if (paths.length === 0) return false;

  const normalizedWorkspace = normalizePath(workspacePath);
  return paths.every((p) => {
    if (!p.startsWith('/')) return false;
    const normalized = normalizePath(p);
    return (
      normalized === normalizedWorkspace ||
      normalized.startsWith(normalizedWorkspace + '/')
    );
  });
}

/**
 * Extract a URL from step parameters.
 */
function extractUrl(params: Record<string, unknown>): string | null {
  const urlKeys = ['url', 'uri', 'endpoint', 'href'];
  for (const key of urlKeys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Check if the URL in parameters targets an allowlisted domain.
 * Supports exact match and subdomain matching.
 */
function isAllowlistedDomain(
  params: Record<string, unknown>,
  allowlist: string[],
): boolean {
  if (allowlist.length === 0) return false;

  const url = extractUrl(params);
  if (!url) return false;

  try {
    const hostname = new URL(url).hostname;
    return allowlist.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Default policy evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the default policy for a step based on its classified action type.
 */
function evaluateDefaultPolicy(
  step: ExecutionStep,
  actionType: ActionType,
  config: PolicyEngineConfig,
): StepPolicyResult {
  const baseRisk = assessStepRisk(step);

  switch (actionType) {
    case 'read_files': {
      const paths = extractPaths(step.parameters);
      if (paths.length > 0 && isWithinWorkspace(paths, config.workspacePath)) {
        return {
          verdict: 'approved',
          category: 'filesystem',
          reasoning: 'File read within allowed workspace path',
          riskLevel: 'low',
        };
      }
      return {
        verdict: 'needs_user_approval',
        category: 'filesystem',
        reasoning:
          paths.length > 0
            ? 'File read outside allowed workspace path'
            : 'File read path could not be verified',
        riskLevel: 'medium',
      };
    }

    case 'write_files': {
      const paths = extractPaths(step.parameters);
      if (paths.length > 0 && isWithinWorkspace(paths, config.workspacePath)) {
        return {
          verdict: 'approved',
          category: 'filesystem',
          reasoning: 'File write within workspace path',
          riskLevel: 'medium',
        };
      }
      return {
        verdict: 'needs_user_approval',
        category: 'filesystem',
        reasoning:
          paths.length > 0
            ? 'File write outside workspace path requires user approval'
            : 'File write path could not be verified',
        riskLevel: 'high',
      };
    }

    case 'delete_files':
      return {
        verdict: 'needs_user_approval',
        category: 'filesystem',
        reasoning: 'File deletion always requires user approval',
        riskLevel: 'high',
      };

    case 'network_get': {
      if (isAllowlistedDomain(step.parameters, config.allowlistedDomains)) {
        return {
          verdict: 'approved',
          category: 'network',
          reasoning: 'Network GET to allowlisted domain',
          riskLevel: 'low',
        };
      }
      return {
        verdict: 'needs_user_approval',
        category: 'network',
        reasoning: 'Network GET to non-allowlisted domain requires user approval',
        riskLevel: 'medium',
      };
    }

    case 'network_mutate':
      return {
        verdict: 'needs_user_approval',
        category: 'network',
        reasoning: 'Mutating network request requires user approval',
        riskLevel: 'high',
      };

    case 'shell_execute':
      return {
        verdict: 'needs_user_approval',
        category: 'security',
        reasoning: 'Shell command execution always requires user approval',
        riskLevel: 'critical',
      };

    case 'credential_usage':
      // TODO(Phase 5): Per Section 5.3.5, credential usage should be
      // "Approved for declared Gear, logged" — i.e. auto-approved when
      // the Gear manifest declares the credential. This requires the
      // Gear manifest system (Phase 5). Until then, default to stricter
      // needs_user_approval as a safe fallback.
      return {
        verdict: 'needs_user_approval',
        category: 'security',
        reasoning: 'Credential usage requires user approval',
        riskLevel: 'medium',
      };

    case 'financial_transaction': {
      const amount =
        typeof step.parameters.amount === 'number'
          ? step.parameters.amount
          : null;
      if (
        config.maxTransactionAmountUsd !== undefined &&
        amount !== null &&
        amount > config.maxTransactionAmountUsd
      ) {
        return {
          verdict: 'rejected',
          category: 'financial',
          reasoning:
            `Transaction amount (${amount}) exceeds hard limit ` +
            `(${config.maxTransactionAmountUsd})`,
          riskLevel: 'critical',
        };
      }
      return {
        verdict: 'needs_user_approval',
        category: 'financial',
        reasoning: 'Financial transaction always requires user approval',
        riskLevel: 'critical',
      };
    }

    case 'send_message':
      return {
        verdict: 'needs_user_approval',
        category: 'communication',
        reasoning: 'Sending messages requires user approval',
        riskLevel: 'high',
      };

    case 'system_config':
      return {
        verdict: 'needs_user_approval',
        category: 'security',
        reasoning: 'System configuration changes always require user approval',
        riskLevel: 'critical',
      };

    case 'unknown':
      return {
        verdict: 'needs_user_approval',
        category: 'unknown',
        reasoning: 'Unclassified action type defaults to requiring user approval',
        riskLevel: baseRisk,
      };

    default: {
      // Exhaustiveness check
      const _exhaustive: never = actionType;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// User policy override application
// ---------------------------------------------------------------------------

/**
 * Apply user policy overrides. Hard floor actions cannot be overridden.
 * Non-floor actions can only be made stricter, never weaker.
 */
function applyUserOverride(
  result: StepPolicyResult,
  actionType: ActionType,
  userPolicies: UserPolicyOverride[],
): StepPolicyResult {
  // Hard floors cannot be overridden at all
  if (HARD_FLOOR_ACTIONS.has(actionType)) {
    return result;
  }

  const override = userPolicies.find((p) => p.actionType === actionType);
  if (!override) return result;

  // Can only make stricter, never weaker
  if (VERDICT_STRICTNESS[override.verdict] > VERDICT_STRICTNESS[result.verdict]) {
    return {
      ...result,
      verdict: override.verdict,
      reasoning: `${result.reasoning} (escalated by user policy)`,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Composite risk detection
// ---------------------------------------------------------------------------

/**
 * Detect composite risk patterns across multiple steps.
 * Returns an array of triggered pattern descriptions.
 */
function detectCompositeRisks(
  classifications: Map<string, ActionType>,
): string[] {
  const triggered: string[] = [];

  for (const pattern of COMPOSITE_PATTERNS) {
    if (pattern.detect(classifications)) {
      triggered.push(pattern.reasoning);
    }
  }

  return triggered;
}

// ---------------------------------------------------------------------------
// Overall verdict computation
// ---------------------------------------------------------------------------

function computeOverallVerdict(
  stepResults: StepValidation[],
): ValidationVerdict {
  let hasNeedsApproval = false;

  for (const step of stepResults) {
    if (step.verdict === 'rejected') return 'rejected';
    if (step.verdict === 'needs_user_approval') hasNeedsApproval = true;
  }

  return hasNeedsApproval ? 'needs_user_approval' : 'approved';
}

function computeOverallRisk(stepResults: StepValidation[]): RiskLevel {
  let maxRisk: RiskLevel = 'low';

  for (const step of stepResults) {
    if (
      step.riskLevel &&
      RISK_LEVEL_ORDER[step.riskLevel] > RISK_LEVEL_ORDER[maxRisk]
    ) {
      maxRisk = step.riskLevel;
    }
  }

  return maxRisk;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate an execution plan against default risk policies.
 *
 * For each step:
 * 1. Classify the action type
 * 2. Evaluate the default policy
 * 3. Apply user overrides (stricter only, hard floors immutable)
 * 4. Log credential usage (Section 5.3.5 audit requirement)
 * 5. Check risk divergence between Scout and Sentinel
 *
 * After all steps:
 * 6. Detect composite risk patterns
 * 7. Compute overall verdict and risk level
 *
 * Returns a complete ValidationResult with per-step verdicts.
 */
export function evaluatePlan(
  plan: ExecutionPlan,
  config: PolicyEngineConfig,
  logger: Logger,
): ValidationResult {
  const stepResults: StepValidation[] = [];
  const classifications = new Map<string, ActionType>();
  const divergences: RiskDivergence[] = [];

  for (const step of plan.steps) {
    const actionType = classifyAction(step);
    classifications.set(step.id, actionType);

    // 1. Evaluate default policy
    let policyResult = evaluateDefaultPolicy(step, actionType, config);

    // 2. Apply user overrides (stricter only)
    if (config.userPolicies && config.userPolicies.length > 0) {
      policyResult = applyUserOverride(policyResult, actionType, config.userPolicies);
    }

    // 3. Log credential usage (Section 5.3.5 requires all credential access logged)
    if (actionType === 'credential_usage') {
      logger.info('Credential usage detected', {
        stepId: step.id,
        gear: step.gear,
        action: step.action,
        verdict: policyResult.verdict,
      });
    }

    // 4. Check risk divergence (Scout vs Sentinel assessment)
    const sentinelRisk = policyResult.riskLevel;
    const divergence = checkRiskDivergence(step.id, step.riskLevel, sentinelRisk);
    if (divergence) {
      divergences.push(divergence);
      logger.warn('Risk divergence detected', {
        stepId: step.id,
        scoutRisk: step.riskLevel,
        sentinelRisk,
        difference: divergence.difference,
        gear: step.gear,
        action: step.action,
      });
    }

    stepResults.push({
      stepId: step.id,
      verdict: policyResult.verdict,
      category: policyResult.category,
      riskLevel: policyResult.riskLevel,
      reasoning: policyResult.reasoning,
    });
  }

  // 5. Composite risk detection
  const compositeReasons = detectCompositeRisks(classifications);
  let reasoning: string | undefined;

  if (compositeReasons.length > 0) {
    reasoning = `Composite risks detected: ${compositeReasons.join('; ')}`;
    logger.warn('Composite risk patterns detected', {
      planId: plan.id,
      patterns: compositeReasons,
    });
  }

  // 6. Compute overall verdict and risk
  let overallVerdict = computeOverallVerdict(stepResults);
  let overallRisk = computeOverallRisk(stepResults);

  // Composite risk escalates overall verdict and risk
  if (compositeReasons.length > 0) {
    if (overallVerdict === 'approved') {
      overallVerdict = 'needs_user_approval';
      reasoning =
        (reasoning ? reasoning + '; ' : '') +
        'Plan escalated to require user approval due to composite risk';
    }
    if (RISK_LEVEL_ORDER[overallRisk] < RISK_LEVEL_ORDER['high']) {
      overallRisk = 'high';
    }
  }

  return {
    id: generateId(),
    planId: plan.id,
    verdict: overallVerdict,
    stepResults,
    overallRisk,
    reasoning,
    metadata: divergences.length > 0 ? { divergences } : undefined,
  };
}
