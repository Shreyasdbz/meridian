// @meridian/sentinel — Sentinel component class (Phase 4.3, updated Phase 9.1)
//
// Wires the policy engine (rule-based and/or LLM-based) to the Axis message
// router so that validate.request messages are handled and validate.response
// messages are returned.
//
// In v0.1, Sentinel is purely rule-based. In v0.2 (Phase 9.1), an LLM-based
// validator is added as the primary validation path, with the rule-based engine
// as a fallback. When an LLM provider is configured, plans are first stripped
// (plan-stripper) then sent to the LLM for evaluation.
//
// INFORMATION BARRIER: Sentinel MUST NOT receive or inspect user messages,
// Journal data, or Gear catalog. It only sees the structured ExecutionPlan
// and system policies. This is enforced at both the code level (no imports
// from journal/) and the message level (payload stripping).
//
// Architecture references:
// - Section 5.1.14 (Startup Sequence — Component Registration)
// - Section 5.3 (Sentinel — Safety Validator)
// - Section 5.3.2 (Validation Categories, Plan Stripping)
// - Section 5.3.5 (Risk Policies)
// - Section 5.3.6 (Sentinel Configuration)
// - Section 9.1 (AxisMessage schema)

import type {
  AxisMessage,
  ComponentId,
  ComponentRegistry,
  ExecutionPlan,
  LLMProvider,
  Logger,
  ValidationResult,
} from '@meridian/shared';
import { generateId, ValidationError } from '@meridian/shared';

import type { ApprovalCache } from './approval-cache.js';
import type { LLMValidatorConfig } from './llm-validator.js';
import { checkSameProvider, validatePlanWithLLM } from './llm-validator.js';
import type { PolicyEngineConfig } from './policy-engine.js';
import { evaluatePlan } from './policy-engine.js';
import { checkRiskDivergence } from './risk-assessor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for Sentinel events.
 */
export interface SentinelLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Configuration for the Sentinel component.
 *
 * In v0.1, Sentinel is rule-based (no LLM). The policy engine config
 * controls workspace paths, allowlisted domains, and user policy overrides.
 *
 * In v0.2, an LLM-based validator can be configured via `llmConfig`.
 * When present, LLM validation is used as the primary path, with rule-based
 * evaluation as fallback if the LLM call fails.
 */
export interface SentinelConfig {
  /** Policy engine configuration for rule-based validation. */
  policyConfig: PolicyEngineConfig;
  /** LLM configuration for v0.2+ LLM-based validation. Optional. */
  llmConfig?: SentinelLLMConfig;
  /**
   * Scout's LLM provider ID. Used for same-provider warning (Section 5.3.6).
   * When both Scout and Sentinel use the same provider, a warning is logged.
   */
  scoutProviderId?: string;
  /** Logger for Sentinel events. */
  logger?: SentinelLogger;
  /** Approval cache for reusing cached approvals on scheduled tasks (v0.4). */
  approvalCache?: ApprovalCache;
}

/**
 * LLM configuration for Sentinel's LLM-based validator.
 */
export interface SentinelLLMConfig {
  /** LLM provider instance for Sentinel. */
  provider: LLMProvider;
  /** Model to use for validation. */
  model: string;
  /** Temperature for validation calls. Default: 0.1. */
  temperature?: number;
  /** Maximum tokens for validation response. Default: 4096. */
  maxTokens?: number;
}

/**
 * Dependencies that Sentinel needs from Axis.
 */
export interface SentinelDependencies {
  /** Component registry for message handler registration. */
  registry: ComponentRegistry;
}

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: SentinelLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Information barrier — payload keys that MUST NOT be present
// ---------------------------------------------------------------------------

/**
 * Keys that violate the information barrier if found in a validate.request
 * payload. Sentinel must never see user messages, Journal data, or
 * Gear catalog information.
 */
const BARRIER_VIOLATION_KEYS: ReadonlySet<string> = new Set([
  'userMessage',
  'conversationHistory',
  'journalData',
  'journalMemories',
  'relevantMemories',
  'gearCatalog',
  'gearManifests',
  'originalMessage',
]);

// ---------------------------------------------------------------------------
// Sentinel component
// ---------------------------------------------------------------------------

/**
 * Sentinel — the safety validation component of Meridian.
 *
 * Registers with Axis as a message handler for `validate.request` messages.
 * Evaluates execution plans using:
 * - LLM-based validation (v0.2+, when llmConfig is provided)
 * - Rule-based policy engine (v0.1, or as fallback when LLM fails)
 *
 * The LLM validator uses plan stripping (Section 5.3.2/5.3.7) to prevent
 * compromised Scout from embedding persuasive content in optional fields.
 *
 * INFORMATION BARRIER:
 * Sentinel enforces a strict information barrier. It:
 * - Has NO imports from `journal/` (enforced by ESLint/dependency-cruiser)
 * - Receives ONLY the execution plan and policy config
 * - Strips and warns about any payload keys that violate the barrier
 * - Never sees user messages, Journal data, or Gear catalog
 *
 * Lifecycle:
 * 1. Create with `createSentinel(config, deps)`
 * 2. Sentinel auto-registers with Axis's component registry
 * 3. Axis dispatches `validate.request` messages to Sentinel's handler
 * 4. Call `dispose()` during shutdown to unregister
 */
export class Sentinel {
  private readonly policyConfig: PolicyEngineConfig;
  private readonly llmConfig: SentinelLLMConfig | undefined;
  private readonly registry: ComponentRegistry;
  private readonly logger: SentinelLogger;
  private readonly useLLM: boolean;
  private readonly approvalCache: ApprovalCache | null;
  private disposed = false;

  constructor(config: SentinelConfig, deps: SentinelDependencies) {
    this.policyConfig = config.policyConfig;
    this.llmConfig = config.llmConfig;
    this.registry = deps.registry;
    this.logger = config.logger ?? noopLogger;
    this.useLLM = !!config.llmConfig;
    this.approvalCache = config.approvalCache ?? null;

    // Register with Axis's component registry
    this.registry.register('sentinel', this.handleMessage.bind(this));

    // Check same-provider warning (Section 5.3.6)
    if (config.llmConfig && config.scoutProviderId) {
      const warning = checkSameProvider(
        config.scoutProviderId,
        config.llmConfig.provider.id,
      );
      if (warning) {
        this.logger.warn(warning.message, {
          scoutProvider: warning.scoutProvider,
          sentinelProvider: warning.sentinelProvider,
        });
      }
    }

    this.logger.info('Sentinel registered with Axis', {
      mode: this.useLLM ? 'llm' : 'rule-based',
      model: this.llmConfig?.model,
      providerId: this.llmConfig?.provider.id,
      workspacePath: this.policyConfig.workspacePath,
      allowlistedDomains: this.policyConfig.allowlistedDomains,
      userPolicies: this.policyConfig.userPolicies?.length ?? 0,
      approvalCache: !!this.approvalCache,
    });
  }

  /**
   * Handle an incoming AxisMessage.
   *
   * Expects `validate.request` messages with the following payload fields:
   * - `plan` (ExecutionPlan, required) — the plan to validate
   *
   * The handler enforces the information barrier by:
   * 1. Rejecting non-validate.request message types
   * 2. Checking for and warning about barrier-violating payload keys
   * 3. Extracting ONLY the execution plan from the payload
   *
   * When LLM is configured, the plan is stripped and sent to the LLM.
   * If LLM validation fails, falls back to rule-based evaluation.
   */
  private async handleMessage(
    message: AxisMessage,
    signal: AbortSignal,
  ): Promise<AxisMessage> {
    if (message.type !== 'validate.request') {
      throw new ValidationError(
        `Sentinel received unexpected message type: '${message.type}'. ` +
          `Expected 'validate.request'.`,
      );
    }

    const payload = message.payload ?? {};

    // Enforce information barrier — warn about violating keys
    this.enforceBarrier(payload, message.id);

    // Extract the execution plan — the ONLY data Sentinel should see
    const plan = payload['plan'] as ExecutionPlan | undefined;
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
      throw new ValidationError(
        'validate.request payload must contain a valid "plan" field ' +
          'with an ExecutionPlan object (id, jobId, steps[])',
      );
    }

    const source = payload['source'] as string | undefined;

    this.logger.debug('Received validate.request', {
      messageId: message.id,
      correlationId: message.correlationId,
      jobId: message.jobId,
      planId: plan.id,
      stepCount: plan.steps.length,
      mode: this.useLLM ? 'llm' : 'rule-based',
    });

    // --- Approval Cache check (v0.4) ---
    // For eligible scheduled tasks, check if we have a cached approval
    if (this.approvalCache && source) {
      if (this.approvalCache.isEligible(plan, source)) {
        const planHash = this.approvalCache.computePlanHash(plan);
        const cachedResult = this.approvalCache.lookup(planHash);
        if (cachedResult) {
          this.logger.info('Approval cache hit — returning cached validation', {
            planId: plan.id,
            planHash,
            verdict: cachedResult.verdict,
          });
          // Tag the result as coming from cache
          const cachedValidation: ValidationResult = {
            ...cachedResult,
            id: generateId(),
            planId: plan.id,
            metadata: {
              ...cachedResult.metadata,
              fromApprovalCache: true,
            },
          };
          return this.buildResponse(message, cachedValidation);
        }
      }
    }

    // Choose validation path
    let validation: ValidationResult;
    if (this.useLLM && this.llmConfig) {
      validation = await this.validateWithLLM(plan, signal);
    } else {
      validation = this.validateWithRules(plan);
    }

    this.logger.info('Plan validation complete', {
      planId: plan.id,
      verdict: validation.verdict,
      overallRisk: validation.overallRisk,
      stepCount: plan.steps.length,
      mode: this.useLLM ? 'llm' : 'rule-based',
      approvedSteps: validation.stepResults.filter(
        (s) => s.verdict === 'approved',
      ).length,
      rejectedSteps: validation.stepResults.filter(
        (s) => s.verdict === 'rejected',
      ).length,
      needsApprovalSteps: validation.stepResults.filter(
        (s) => s.verdict === 'needs_user_approval',
      ).length,
    });

    // --- Store in Approval Cache (v0.4) ---
    // Cache approved results for eligible scheduled tasks
    if (this.approvalCache && source) {
      if (this.approvalCache.isEligible(plan, source)) {
        const planHash = this.approvalCache.computePlanHash(plan);
        this.approvalCache.store(planHash, validation);
      }
    }

    // Build and return validate.response
    return this.buildResponse(message, validation);
  }

  /**
   * Validate using the LLM-based validator with rule-based fallback.
   *
   * If the LLM call fails, logs the error and falls back to rule-based
   * evaluation to maintain availability.
   */
  private async validateWithLLM(
    plan: ExecutionPlan,
    signal: AbortSignal,
  ): Promise<ValidationResult> {
    const llm = this.llmConfig;
    if (!llm) {
      return this.validateWithRules(plan);
    }

    try {
      const llmValidatorConfig: LLMValidatorConfig = {
        provider: llm.provider,
        model: llm.model,
        temperature: llm.temperature,
        maxTokens: llm.maxTokens,
        logger: this.logger,
      };

      const result = await validatePlanWithLLM(plan, llmValidatorConfig, signal);

      // Check risk divergence between Scout's declared risk and LLM's assessment
      // Per Section 5.3.2: divergence > 1 level is logged as an anomaly
      this.logRiskDivergence(plan, result);

      return result;
    } catch (error) {
      this.logger.warn('LLM validation failed, falling back to rule-based evaluation', {
        planId: plan.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to rule-based
      const ruleResult = this.validateWithRules(plan);
      // Mark that this was a fallback result
      ruleResult.metadata = {
        ...ruleResult.metadata,
        llmFallback: true,
        llmError: error instanceof Error ? error.message : String(error),
      };
      return ruleResult;
    }
  }

  /**
   * Log risk divergence between Scout's declared risk levels and Sentinel
   * LLM's independent assessment. Per Section 5.3.2, divergence of more
   * than one level is logged as an anomaly for audit review.
   */
  private logRiskDivergence(
    plan: ExecutionPlan,
    result: ValidationResult,
  ): void {
    for (const stepResult of result.stepResults) {
      const planStep = plan.steps.find((s) => s.id === stepResult.stepId);
      if (!planStep || !stepResult.riskLevel) {
        continue;
      }

      const divergence = checkRiskDivergence(
        stepResult.stepId,
        planStep.riskLevel,
        stepResult.riskLevel,
      );

      if (divergence) {
        this.logger.warn('Risk divergence detected between Scout and Sentinel LLM', {
          planId: plan.id,
          stepId: divergence.stepId,
          scoutRisk: divergence.scoutRisk,
          sentinelRisk: divergence.sentinelRisk,
          difference: divergence.difference,
        });
      }
    }
  }

  /**
   * Validate using the rule-based policy engine.
   */
  private validateWithRules(plan: ExecutionPlan): ValidationResult {
    return evaluatePlan(plan, this.policyConfig, this.logger as Logger);
  }

  /**
   * Enforce the information barrier by checking for payload keys that
   * Sentinel should never receive. Violations are logged as warnings
   * but do not block processing — the violating data is simply ignored.
   *
   * This is a defense-in-depth measure. The primary barrier is at the
   * Axis dispatch level (which should strip these fields before sending
   * to Sentinel). This check catches any bypass.
   */
  private enforceBarrier(
    payload: Record<string, unknown>,
    messageId: string,
  ): void {
    const violations: string[] = [];

    for (const key of Object.keys(payload)) {
      if (BARRIER_VIOLATION_KEYS.has(key)) {
        violations.push(key);
      }
    }

    if (violations.length > 0) {
      this.logger.warn('Information barrier violation detected in validate.request', {
        messageId,
        violatingKeys: violations,
        note: 'These fields are being ignored — Sentinel only processes the execution plan',
      });
    }
  }

  /**
   * Build a validate.response AxisMessage from a ValidationResult.
   */
  private buildResponse(
    request: AxisMessage,
    validation: ValidationResult,
  ): AxisMessage {
    return {
      id: generateId(),
      correlationId: request.correlationId,
      timestamp: new Date().toISOString(),
      from: 'sentinel' as ComponentId,
      to: request.from,
      type: 'validate.response',
      payload: validation as unknown as Record<string, unknown>,
      replyTo: request.id,
      jobId: request.jobId,
    };
  }

  /**
   * Get the current policy configuration.
   */
  getPolicyConfig(): PolicyEngineConfig {
    return this.policyConfig;
  }

  /**
   * Check if LLM-based validation is enabled.
   */
  isLLMEnabled(): boolean {
    return this.useLLM;
  }

  /**
   * Get the LLM model being used (if LLM is enabled).
   */
  getLLMModel(): string | undefined {
    return this.llmConfig?.model;
  }

  /**
   * Unregister Sentinel from Axis.
   * Call during shutdown to clean up.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.registry.unregister('sentinel');
    this.disposed = true;

    this.logger.info('Sentinel unregistered from Axis');
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a Sentinel component and register it with Axis.
 *
 * @example
 * ```ts
 * // v0.1 — Rule-based only
 * const sentinel = createSentinel(
 *   {
 *     policyConfig: {
 *       workspacePath: '/data/workspace',
 *       allowlistedDomains: ['api.example.com'],
 *     },
 *   },
 *   { registry: axis.internals.registry },
 * );
 *
 * // v0.2 — LLM-based with rule-based fallback
 * const sentinel = createSentinel(
 *   {
 *     policyConfig: {
 *       workspacePath: '/data/workspace',
 *       allowlistedDomains: ['api.example.com'],
 *     },
 *     llmConfig: {
 *       provider: openaiProvider,
 *       model: 'gpt-4o',
 *     },
 *     scoutProviderId: 'anthropic', // triggers same-provider warning if match
 *   },
 *   { registry: axis.internals.registry },
 * );
 *
 * // During shutdown:
 * sentinel.dispose();
 * ```
 */
export function createSentinel(
  config: SentinelConfig,
  deps: SentinelDependencies,
): Sentinel {
  return new Sentinel(config, deps);
}
