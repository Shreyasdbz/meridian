// @meridian/scout — Scout component class (Phase 3.5)
//
// Wires the Planner to the Axis message router so that plan.request
// messages are handled and plan.response messages are returned.
//
// Architecture references:
// - Section 5.1.14 (Startup Sequence — Component Registration)
// - Section 5.2 (Scout — Planner LLM)
// - Section 5.2.6 (Model Selection — primary/secondary)
// - Section 9.1 (AxisMessage schema)

import type {
  AxisMessage,
  ComponentId,
  ComponentRegistry,
  GearManifest,
  LLMProvider,
  ModelRoutingDecision,
} from '@meridian/shared';
import { generateId, ValidationError } from '@meridian/shared';

import { createFailureState } from './failure-handler.js';
import { ModelRouter } from './model-router.js';
import type { PlanReplayCache } from './plan-replay-cache.js';
import { Planner } from './planner.js';
import type {
  PlannerAuditWriter,
  PlannerLogger,
  PlanRequest,
  PlanResult,
  PlanError,
} from './planner.js';
import { PLAN_GENERATION_TEMPLATE } from './prompts/plan-generation.js';
import type { SemanticCache } from './semantic-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the Scout component.
 *
 * Model selection (Section 5.2.6):
 * - `primaryModel` is used for all operations in v0.1-v0.3
 * - `secondaryModel` is defined but ignored until v0.4 (adaptive model selection)
 */
export interface ScoutConfig {
  /** LLM provider instance to use for plan generation. */
  provider: LLMProvider;
  /** Primary model name — used for all operations in v0.1-v0.3. */
  primaryModel: string;
  /** Secondary model name — reserved for v0.4 adaptive model selection. Not used in v0.1. */
  secondaryModel?: string;
  /** Temperature for LLM calls. Default: 0.3. */
  temperature?: number;
  /** Available Gear catalog for system prompt and path verification. */
  gearCatalog?: GearManifest[];
  /** User preferences to include in context. */
  userPreferences?: string;
  /** Logger for Scout events. */
  logger?: PlannerLogger;
  /** Audit writer for LLM API call logging (Section 7.3). */
  auditWriter?: PlannerAuditWriter;
  /** Maximum context messages to include. */
  maxContextMessages?: number;
  /** Per-job token budget. */
  jobTokenBudget?: number;
  /** Plan replay cache for skipping LLM calls on repeated scheduled tasks (v0.4). */
  planReplayCache?: PlanReplayCache;
  /** Semantic response cache for caching LLM responses (v0.4). */
  semanticCache?: SemanticCache;
}

/**
 * Dependencies that Scout needs from Axis.
 */
export interface ScoutDependencies {
  /** Component registry for message handler registration. */
  registry: ComponentRegistry;
}

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: PlannerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Scout component
// ---------------------------------------------------------------------------

/**
 * Scout — the planner component of Meridian.
 *
 * Registers with Axis as a message handler for `plan.request` messages.
 * Delegates to the underlying Planner for plan generation, then wraps
 * the result in an AxisMessage `plan.response`.
 *
 * Lifecycle:
 * 1. Create with `createScout(config, deps)`
 * 2. Scout auto-registers with Axis's component registry
 * 3. Axis dispatches `plan.request` messages to Scout's handler
 * 4. Call `dispose()` during shutdown to unregister
 */
export class Scout {
  private readonly planner: Planner;
  private readonly registry: ComponentRegistry;
  private readonly logger: PlannerLogger;
  private readonly config: ScoutConfig;
  private readonly modelRouter: ModelRouter | null;
  private readonly planReplayCache: PlanReplayCache | null;
  private readonly semanticCache: SemanticCache | null;
  private disposed = false;

  constructor(config: ScoutConfig, deps: ScoutDependencies) {
    this.config = config;
    this.registry = deps.registry;
    this.logger = config.logger ?? noopLogger;
    this.planReplayCache = config.planReplayCache ?? null;
    this.semanticCache = config.semanticCache ?? null;

    // Adaptive model selection (Phase 11.1, Section 5.2.6):
    // When secondaryModel is configured, create a ModelRouter for
    // task-type routing between primary and secondary models.
    if (config.secondaryModel) {
      this.modelRouter = new ModelRouter({
        primaryModel: config.primaryModel,
        secondaryModel: config.secondaryModel,
        logger: this.logger,
      });
      this.logger.info('Adaptive model selection enabled', {
        primaryModel: config.primaryModel,
        secondaryModel: config.secondaryModel,
      });
    } else {
      this.modelRouter = null;
    }

    // Create the underlying Planner with the primary model
    this.planner = new Planner({
      provider: config.provider,
      model: config.primaryModel,
      temperature: config.temperature,
      gearCatalog: config.gearCatalog,
      userPreferences: config.userPreferences,
      logger: config.logger,
      auditWriter: config.auditWriter,
      maxContextMessages: config.maxContextMessages,
      jobTokenBudget: config.jobTokenBudget,
    });

    // Register with Axis's component registry
    this.registry.register('scout', this.handleMessage.bind(this));

    this.logger.info('Scout registered with Axis', {
      primaryModel: config.primaryModel,
      secondaryModel: config.secondaryModel ?? '(not configured)',
      promptVersion: PLAN_GENERATION_TEMPLATE.version,
      planReplayCache: !!this.planReplayCache,
      semanticCache: !!this.semanticCache,
    });
  }

  /**
   * Handle an incoming AxisMessage.
   *
   * Expects `plan.request` messages with the following payload fields:
   * - `userMessage` (string, required)
   * - `jobId` (string, from message.jobId or payload)
   * - `conversationId` (string, optional)
   * - `conversationHistory` (Message[], optional)
   * - `relevantMemories` (string[], optional)
   * - `activeJobs` (array, optional)
   * - `failureState` (PlanningFailureState, optional)
   * - `additionalContext` (string, optional)
   * - `forceFullPath` (boolean, optional)
   * - `cumulativeTokens` (number, optional)
   */
  private async handleMessage(
    message: AxisMessage,
    signal: AbortSignal,
  ): Promise<AxisMessage> {
    if (message.type !== 'plan.request') {
      throw new ValidationError(
        `Scout received unexpected message type: '${message.type}'. Expected 'plan.request'.`,
      );
    }

    const payload = message.payload ?? {};
    const jobId = message.jobId ?? (payload['jobId'] as string | undefined) ?? '';

    if (!payload['userMessage'] || typeof payload['userMessage'] !== 'string') {
      throw new ValidationError(
        'plan.request payload must contain a string "userMessage" field',
      );
    }

    this.logger.debug('Received plan.request', {
      messageId: message.id,
      correlationId: message.correlationId,
      jobId,
      from: message.from,
    });

    const userMessage = payload['userMessage'];
    const source = payload['source'] as string | undefined;
    const gearCatalogIds = this.config.gearCatalog?.map((g) => g.id);

    // --- Plan Replay Cache check (v0.4) ---
    // For scheduled tasks, check if we have a cached plan
    if (this.planReplayCache && source === 'schedule') {
      const inputHash = this.planReplayCache.computeInputHash({
        userMessage,
        gearCatalog: gearCatalogIds,
      });
      const cachedPlan = this.planReplayCache.lookup(inputHash);
      if (cachedPlan) {
        this.planReplayCache.recordHit(inputHash);
        this.logger.info('Plan replay cache hit — skipping LLM call', {
          jobId,
          inputHash,
          planId: cachedPlan.id,
        });

        const cacheResult: PlanResult = {
          path: 'full',
          plan: cachedPlan,
          usage: { inputTokens: 0, outputTokens: 0 },
          failureState: createFailureState(),
        };
        return this.buildResponse(message, cacheResult);
      }
    }

    // --- Semantic Cache check (v0.4) ---
    // For conversational queries, check if we have a cached response
    if (this.semanticCache) {
      const cachedResponse = await this.semanticCache.lookup(
        userMessage,
        this.config.primaryModel,
      );
      if (cachedResponse) {
        this.logger.info('Semantic cache hit — returning cached response', {
          jobId,
          responseLength: cachedResponse.length,
        });

        const cacheResult: PlanResult = {
          path: 'fast',
          text: cachedResponse,
          usage: { inputTokens: 0, outputTokens: 0 },
          failureState: createFailureState(),
        };
        return this.buildResponse(message, cacheResult);
      }
    }

    // Build PlanRequest from the AxisMessage payload
    const planRequest: PlanRequest = {
      userMessage,
      jobId,
      conversationId: payload['conversationId'] as string | undefined,
      conversationHistory: payload['conversationHistory'] as PlanRequest['conversationHistory'],
      relevantMemories: payload['relevantMemories'] as string[] | undefined,
      activeJobs: payload['activeJobs'] as PlanRequest['activeJobs'],
      failureState: payload['failureState'] as PlanRequest['failureState'],
      additionalContext: payload['additionalContext'] as string | undefined,
      forceFullPath: payload['forceFullPath'] as boolean | undefined,
      cumulativeTokens: payload['cumulativeTokens'] as number | undefined,
      signal,
    };

    // Adaptive model selection (Phase 11.1):
    // When a ModelRouter is available, classify the task and select model.
    let routingDecision: ModelRoutingDecision | undefined;
    if (this.modelRouter) {
      routingDecision = this.modelRouter.route({
        userMessage: planRequest.userMessage,
        conversationHistory: planRequest.conversationHistory?.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        hasFailureState: !!(
          planRequest.failureState &&
          (planRequest.failureState.revisionCount > 0 ||
           planRequest.failureState.replanCount > 0 ||
           planRequest.failureState.malformedJsonRetries > 0)
        ),
        forceFullPath: planRequest.forceFullPath,
        jobId,
      });

      // Pass the selected model as override to the Planner
      planRequest.modelOverride = routingDecision.model;

      this.logger.debug('Model routing applied', {
        jobId,
        tier: routingDecision.tier,
        model: routingDecision.model,
        complexity: routingDecision.taskComplexity,
      });
    }

    // Delegate to the Planner
    const result = await this.planner.generatePlan(planRequest);

    // Attach routing decision metadata to successful plan responses
    if (routingDecision && !('type' in result) && result.path === 'full' && result.plan) {
      result.plan.metadata = {
        ...result.plan.metadata,
        modelRouting: routingDecision,
      };
    }

    // --- Post-generation cache storage (v0.4) ---
    if (!('type' in result)) {
      // Store in plan replay cache if eligible
      if (
        this.planReplayCache &&
        source === 'schedule' &&
        result.path === 'full' &&
        result.plan
      ) {
        if (this.planReplayCache.isCacheable(result.plan, 'schedule')) {
          const inputHash = this.planReplayCache.computeInputHash({
            userMessage,
            gearCatalog: gearCatalogIds,
          });
          this.planReplayCache.store(inputHash, result.plan);
        }
      }

      // Store in semantic cache if fast-path response
      if (this.semanticCache && result.path === 'fast' && result.text) {
        await this.semanticCache.store(
          userMessage,
          result.text,
          this.config.primaryModel,
        );
      }
    }

    // Build and return plan.response AxisMessage
    return this.buildResponse(message, result);
  }

  /**
   * Build a plan.response AxisMessage from a PlanResult or PlanError.
   */
  private buildResponse(
    request: AxisMessage,
    result: PlanResult | PlanError,
  ): AxisMessage {
    // PlanError has 'type' field; PlanResult has 'path' field.
    // Presence of 'type' distinguishes error responses.
    const isError = 'type' in result;

    const responseType: AxisMessage['type'] = isError ? 'error' : 'plan.response';

    return {
      id: generateId(),
      correlationId: request.correlationId,
      timestamp: new Date().toISOString(),
      from: 'scout' as ComponentId,
      to: request.from,
      type: responseType,
      payload: result as unknown as Record<string, unknown>,
      replyTo: request.id,
      jobId: request.jobId,
    };
  }

  /**
   * Get the prompt template version in use.
   */
  getPromptVersion(): string {
    return PLAN_GENERATION_TEMPLATE.version;
  }

  /**
   * Get the primary model name.
   */
  getPrimaryModel(): string {
    return this.config.primaryModel;
  }

  /**
   * Get the secondary model name (reserved for v0.4).
   */
  getSecondaryModel(): string | undefined {
    return this.config.secondaryModel;
  }

  /**
   * Unregister Scout from Axis.
   * Call during shutdown to clean up.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.registry.unregister('scout');
    this.disposed = true;

    this.logger.info('Scout unregistered from Axis');
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a Scout component and register it with Axis.
 *
 * @example
 * ```ts
 * const scout = createScout(
 *   {
 *     provider: anthropicProvider,
 *     primaryModel: 'claude-sonnet-4-5-20250929',
 *     secondaryModel: 'claude-haiku-4-5-20251001', // ignored until v0.4
 *     gearCatalog: registeredGear,
 *   },
 *   { registry: axis.internals.registry },
 * );
 *
 * // Scout is now handling plan.request messages via Axis
 *
 * // During shutdown:
 * scout.dispose();
 * ```
 */
export function createScout(config: ScoutConfig, deps: ScoutDependencies): Scout {
  return new Scout(config, deps);
}
