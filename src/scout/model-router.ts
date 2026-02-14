// @meridian/scout — Adaptive Model Router (Phase 11.1)
//
// Task-type enumeration routing for selecting primary vs secondary LLM model.
// NOT LLM-based judgment — uses heuristics on user message and context.
//
// Architecture references:
// - Section 5.2.6 (Model Selection — primary/secondary)
// - Section 11.1 (Adaptive Model Selection)

import type { ModelRoutingDecision, ModelTier, TaskComplexity } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelRouterConfig {
  primaryModel: string;
  secondaryModel: string;
  logger?: ModelRouterLogger;
}

export interface ModelRouterLogger {
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Constants — heuristic patterns
// ---------------------------------------------------------------------------

/**
 * Patterns indicating multi-step tasks that require the primary model.
 * These suggest complex orchestration or sequential reasoning.
 */
const MULTI_STEP_PATTERNS: RegExp[] = [
  /\bthen\b.*\b(?:and|also|next)\b/i,
  /\bafter that\b/i,
  /\band also\b/i,
  /\band then\b/i,
  /\bfirst\b.*\bthen\b/i,
  /\bstep\s*\d/i,
  /\bfollow(?:ed)?\s+by\b/i,
  /\bsequentially\b/i,
  /\bmultiple\s+(?:steps|tasks|things)\b/i,
  /\bbatch\b.*\bprocess/i,
];

/**
 * Patterns indicating simple questions or greetings
 * that can use the secondary model.
 */
const SIMPLE_QUERY_PATTERNS: RegExp[] = [
  /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))\b/i,
  /^(?:thanks|thank\s+you|ty)\b/i,
  /^(?:what|who|where|when|how|why|is|are|can|could|would|does|do)\s/i,
  /^(?:tell me|explain|describe|summarize|what's)\s/i,
  /\?$/,
];

/**
 * Patterns indicating well-known single Gear operations
 * that the secondary model can handle.
 */
const SIMPLE_GEAR_PATTERNS: RegExp[] = [
  /\b(?:send|write|compose)\s+(?:an?\s+)?email\b/i,
  /\b(?:read|check|get)\s+(?:my\s+)?(?:email|mail)\b/i,
  /\b(?:create|make|add)\s+(?:a\s+)?(?:file|folder|directory)\b/i,
  /\b(?:delete|remove)\s+(?:a\s+)?(?:file|folder)\b/i,
  /\b(?:list|show|display)\s+(?:files|folders)\b/i,
  /\b(?:search|find|look\s+for)\s+(?:a\s+)?file\b/i,
  /\bset\s+(?:a\s+)?(?:timer|reminder|alarm)\b/i,
  /\b(?:fetch|get|download)\s+(?:from\s+)?(?:url|page|website)\b/i,
  /\b(?:run|execute)\s+(?:a\s+)?(?:command|script)\b/i,
];

/**
 * Patterns indicating summarization tasks.
 */
const SUMMARIZATION_PATTERNS: RegExp[] = [
  /\bsummariz/i,
  /\btl;?dr\b/i,
  /\bbrief(?:ly)?\b.*\b(?:tell|explain|describe)\b/i,
  /\bin\s+(?:a\s+)?(?:few\s+)?(?:words|sentences|brief)\b/i,
  /\bgist\s+of\b/i,
  /\bkey\s+(?:points|takeaways)\b/i,
];

/**
 * Patterns indicating parsing/extraction tasks.
 */
const PARSING_PATTERNS: RegExp[] = [
  /\bpars[ei]/i,
  /\bextract\b/i,
  /\bconvert\b.*\bto\b/i,
  /\btransform\b.*\b(?:into|to)\b/i,
  /\bformat\b.*\bas\b/i,
];

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: ModelRouterLogger = {
  info: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify task complexity from the user message and context.
 *
 * Uses heuristics — not LLM-based judgment — to determine
 * which category the task falls into. The classification
 * directly maps to a model tier selection.
 */
export function classifyTaskComplexity(options: {
  userMessage: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  hasFailureState?: boolean;
  forceFullPath?: boolean;
}): TaskComplexity {
  const { userMessage, hasFailureState, forceFullPath } = options;
  const trimmed = userMessage.trim();

  // Replanning or forced full path always uses primary
  if (hasFailureState) {
    return 'replanning';
  }

  if (forceFullPath) {
    return 'complex_reasoning';
  }

  // Multi-step patterns → primary
  for (const pattern of MULTI_STEP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'multi_step_planning';
    }
  }

  // Summarization → secondary
  for (const pattern of SUMMARIZATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'summarization';
    }
  }

  // Parsing/extraction → secondary
  for (const pattern of PARSING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'parsing';
    }
  }

  // Simple Gear operations → secondary
  for (const pattern of SIMPLE_GEAR_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'simple_gear_op';
    }
  }

  // Simple questions/greetings → secondary (parameter_generation for greetings)
  for (const pattern of SIMPLE_QUERY_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Very short messages (< 30 chars) are likely greetings or trivial questions
      if (trimmed.length < 30) {
        return 'parameter_generation';
      }
      return 'summarization';
    }
  }

  // Long, complex messages default to primary
  if (trimmed.length > 200) {
    return 'novel_request';
  }

  // Default → novel_request → primary (fail-safe: always default to primary)
  return 'novel_request';
}

/**
 * Select the appropriate model tier based on task complexity.
 *
 * Secondary model handles: simple_gear_op, summarization, parsing, parameter_generation.
 * Primary model handles: multi_step_planning, complex_reasoning, replanning, novel_request.
 */
export function selectModelTier(complexity: TaskComplexity): ModelTier {
  switch (complexity) {
    case 'simple_gear_op':
    case 'summarization':
    case 'parsing':
    case 'parameter_generation':
      return 'secondary';

    case 'multi_step_planning':
    case 'complex_reasoning':
    case 'replanning':
    case 'novel_request':
      return 'primary';
  }
}

// ---------------------------------------------------------------------------
// ModelRouter class
// ---------------------------------------------------------------------------

/**
 * Model Router — classifies task complexity and selects the appropriate
 * LLM model tier for Scout plan generation.
 *
 * Combines classifyTaskComplexity + selectModelTier + logging into a
 * single convenience class.
 */
export class ModelRouter {
  private readonly config: ModelRouterConfig;
  private readonly logger: ModelRouterLogger;

  constructor(config: ModelRouterConfig) {
    this.config = config;
    this.logger = config.logger ?? noopLogger;

    this.logger.info('ModelRouter initialized', {
      primaryModel: config.primaryModel,
      secondaryModel: config.secondaryModel,
    });
  }

  /**
   * Route a task to the appropriate model based on heuristic classification.
   *
   * @returns A routing decision containing the selected model, tier, reason,
   *          and classified task complexity.
   */
  route(options: {
    userMessage: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    hasFailureState?: boolean;
    forceFullPath?: boolean;
    jobId?: string;
  }): ModelRoutingDecision {
    const complexity = classifyTaskComplexity({
      userMessage: options.userMessage,
      conversationHistory: options.conversationHistory,
      hasFailureState: options.hasFailureState,
      forceFullPath: options.forceFullPath,
    });

    const tier = selectModelTier(complexity);
    const model = tier === 'primary'
      ? this.config.primaryModel
      : this.config.secondaryModel;

    const reason = `Task classified as '${complexity}' -> ${tier} model`;

    const decision: ModelRoutingDecision = {
      tier,
      model,
      reason,
      taskComplexity: complexity,
    };

    this.logger.debug('Model routing decision', {
      jobId: options.jobId,
      complexity,
      tier,
      model,
      messageLength: options.userMessage.length,
    });

    return decision;
  }
}
