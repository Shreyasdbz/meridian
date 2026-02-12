// @meridian/sentinel — Sentinel component class (Phase 4.3)
//
// Wires the rule-based policy engine to the Axis message router so that
// validate.request messages are handled and validate.response messages
// are returned.
//
// INFORMATION BARRIER: Sentinel MUST NOT receive or inspect user messages,
// Journal data, or Gear catalog. It only sees the structured ExecutionPlan
// and system policies. This is enforced at both the code level (no imports
// from journal/) and the message level (payload stripping).
//
// Architecture references:
// - Section 5.1.14 (Startup Sequence — Component Registration)
// - Section 5.3 (Sentinel — Safety Validator)
// - Section 5.3.5 (Risk Policies)
// - Section 9.1 (AxisMessage schema)

import type {
  AxisMessage,
  ComponentId,
  ComponentRegistry,
  ExecutionPlan,
  Logger,
  ValidationResult,
} from '@meridian/shared';
import { generateId, ValidationError } from '@meridian/shared';

import type { PolicyEngineConfig } from './policy-engine.js';
import { evaluatePlan } from './policy-engine.js';

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
 */
export interface SentinelConfig {
  /** Policy engine configuration for rule-based validation. */
  policyConfig: PolicyEngineConfig;
  /** Logger for Sentinel events. */
  logger?: SentinelLogger;
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
 * Evaluates execution plans against the rule-based policy engine and
 * returns a `validate.response` containing the ValidationResult.
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
  private readonly registry: ComponentRegistry;
  private readonly logger: SentinelLogger;
  private disposed = false;

  constructor(config: SentinelConfig, deps: SentinelDependencies) {
    this.policyConfig = config.policyConfig;
    this.registry = deps.registry;
    this.logger = config.logger ?? noopLogger;

    // Register with Axis's component registry
    this.registry.register('sentinel', this.handleMessage.bind(this));

    this.logger.info('Sentinel registered with Axis', {
      workspacePath: this.policyConfig.workspacePath,
      allowlistedDomains: this.policyConfig.allowlistedDomains,
      userPolicies: this.policyConfig.userPolicies?.length ?? 0,
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
   */
  private handleMessage(
    message: AxisMessage,
    _signal: AbortSignal,
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

    this.logger.debug('Received validate.request', {
      messageId: message.id,
      correlationId: message.correlationId,
      jobId: message.jobId,
      planId: plan.id,
      stepCount: plan.steps.length,
    });

    // Evaluate the plan against policies
    // Note: In v0.1, Sentinel uses a synchronous rule-based engine.
    // In v0.2, this will become async when the LLM-based validator is added.
    const validation = evaluatePlan(
      plan,
      this.policyConfig,
      this.logger as Logger,
    );

    this.logger.info('Plan validation complete', {
      planId: plan.id,
      verdict: validation.verdict,
      overallRisk: validation.overallRisk,
      stepCount: plan.steps.length,
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

    // Build and return validate.response
    return Promise.resolve(this.buildResponse(message, validation));
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
 * // Sentinel is now handling validate.request messages via Axis
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
