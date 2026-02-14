// @meridian/scout — Plan generation and context assembly (Phase 3.3)
//
// Core Scout logic: receives user message + context, calls LLM provider,
// produces an ExecutionPlan or plain text response.
//
// Architecture references:
// - Section 5.2.2 (Execution Plan Format)
// - Section 5.2.3 (Context Management)
// - Section 5.2.7 (LLM Failure Modes) — handled by failure-handler.ts
// - Section 5.2.8 (Prompt Injection Defense)
// - Section 6.2 LLM09 (Misinformation) — source attribution, confidence
// - Section 6.2 LLM10 (Unbounded Consumption) — per-job token budget
// - Section 7.3 (LLM API Data Handling) — audit logging

import type {
  ChatChunk,
  ChatMessage,
  ExecutionPlan,
  GearManifest,
  LLMProvider,
  Message,
} from '@meridian/shared';
import {
  generateId,
  SYSTEM_PROMPT_TOKEN_BUDGET,
  CONVERSATION_TOKEN_BUDGET,
  MEMORY_TOKEN_BUDGET,
  DEFAULT_CONTEXT_MESSAGES,
  DEFAULT_MEMORY_TOP_K,
  DEFAULT_JOB_TOKEN_BUDGET,
} from '@meridian/shared';

import {
  classifyFailure,
  checkRepetitiveOutput,
  createFailureState,
  incrementRetryCount,
} from './failure-handler.js';
import type { FailureAction, PlanningFailureState } from './failure-handler.js';
import { detectAndVerifyPath } from './path-detector.js';
import type { FastPathVerificationContext, PathDetectionResult } from './path-detector.js';
import {
  SCOUT_IDENTITY,
  SAFETY_RULES,
  FORCE_FULL_PATH_INSTRUCTION,
  EXECUTION_PLAN_SCHEMA,
} from './prompts/plan-generation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Logger interface for planner events. */
export interface PlannerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/** Audit writer for logging LLM API calls (Section 7.3). */
export interface PlannerAuditWriter {
  write(entry: {
    actor: 'scout';
    action: string;
    riskLevel: 'low' | 'medium';
    jobId?: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

/** Options for creating a planner. */
export interface PlannerOptions {
  /** LLM provider to use for plan generation. */
  provider: LLMProvider;
  /** Model name to use for chat requests. */
  model: string;
  /** Temperature for LLM calls. */
  temperature?: number;
  /** Available Gear catalog for system prompt and path verification. */
  gearCatalog?: GearManifest[];
  /** User preferences to include in context. */
  userPreferences?: string;
  /** Logger for planner events. */
  logger?: PlannerLogger;
  /** Audit writer for LLM API call logging (Section 7.3). */
  auditWriter?: PlannerAuditWriter;
  /** Maximum context messages to include. Default: DEFAULT_CONTEXT_MESSAGES. */
  maxContextMessages?: number;
  /** Per-job token budget. Default: DEFAULT_JOB_TOKEN_BUDGET. */
  jobTokenBudget?: number;
}

/** Input to the plan generation function. */
export interface PlanRequest {
  /** The user's message. */
  userMessage: string;
  /** The job ID this plan is for. */
  jobId: string;
  /** Conversation ID for context. */
  conversationId?: string;
  /** Recent conversation messages. */
  conversationHistory?: Message[];
  /** Relevant memories from Journal (stubbed in v0.1). */
  relevantMemories?: string[];
  /** Active job states for context. */
  activeJobs?: Array<{ id: string; status: string; description?: string }>;
  /** Existing failure state (for retries). */
  failureState?: PlanningFailureState;
  /** Additional context to prepend (e.g., retry instructions from failure handler). */
  additionalContext?: string;
  /** Whether to force full-path mode (e.g., after fast-path verification failure). */
  forceFullPath?: boolean;
  /** Cumulative token usage for this job (for budget enforcement). */
  cumulativeTokens?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /**
   * Model override for adaptive model selection (Phase 11.1).
   * When present, this model is used instead of the planner's default model.
   */
  modelOverride?: string;
}

/** Result of plan generation. */
export interface PlanResult {
  /** Whether this is a fast-path (text) or full-path (plan) response. */
  path: 'fast' | 'full';
  /** Plain text response (fast-path only). */
  text?: string;
  /** Execution plan (full-path only). */
  plan?: ExecutionPlan;
  /** Token usage for this call. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Updated failure state. */
  failureState: PlanningFailureState;
  /** If the response requires re-routing (fast-path verification failed). */
  requiresReroute?: boolean;
  /** Reroute reason if applicable. */
  rerouteReason?: string;
}

/** Error result from plan generation. */
export interface PlanError {
  /** Type of error. */
  type: 'budget_exceeded' | 'failure' | 'escalate_to_user';
  /** Human-readable error message. */
  message: string;
  /** Recommended action. */
  action: FailureAction;
  /** Updated failure state. */
  failureState: PlanningFailureState;
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

const noopAuditWriter: PlannerAuditWriter = {
  write: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// System prompt construction (Section 5.2.8)
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for Scout.
 * Includes core instructions, safety rules, Gear catalog, and user preferences.
 * Respects the SYSTEM_PROMPT_TOKEN_BUDGET.
 */
export function buildSystemPrompt(options: {
  provider: LLMProvider;
  gearCatalog?: GearManifest[];
  userPreferences?: string;
  forceFullPath?: boolean;
}): string {
  const sections: string[] = [];

  // Core instructions + safety rules (from versioned prompt template)
  sections.push(`${SCOUT_IDENTITY}\n\n${SAFETY_RULES}`);

  // Force full path instruction
  if (options.forceFullPath) {
    sections.push(FORCE_FULL_PATH_INSTRUCTION);
  }

  // ExecutionPlan schema
  sections.push(EXECUTION_PLAN_SCHEMA);

  // Available Gear catalog
  if (options.gearCatalog && options.gearCatalog.length > 0) {
    const gearList = options.gearCatalog.map((gear) => {
      const actions = gear.actions.map((a) =>
        `  - ${a.name}: ${a.description} (risk: ${a.riskLevel})`,
      ).join('\n');
      return `${gear.id} (${gear.name}): ${gear.description}\n${actions}`;
    });

    const gearSection = `Available Gear (plugins):\n${gearList.join('\n\n')}`;

    // Respect token budget — truncate if needed
    const gearTokens = options.provider.estimateTokens(gearSection);
    const budgetRemaining = SYSTEM_PROMPT_TOKEN_BUDGET -
      options.provider.estimateTokens(sections.join('\n\n'));

    if (gearTokens <= budgetRemaining) {
      sections.push(gearSection);
    } else {
      // Truncate to fit budget
      const truncated = gearSection.slice(0, budgetRemaining * 4); // rough chars estimate
      sections.push(truncated + '\n[Gear catalog truncated for context budget]');
    }
  }

  // User preferences
  if (options.userPreferences) {
    const prefTokens = options.provider.estimateTokens(options.userPreferences);
    if (prefTokens < 500) {
      sections.push(`User Preferences:\n${options.userPreferences}`);
    }
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Context assembly (Section 5.2.3)
// ---------------------------------------------------------------------------

/**
 * Assemble context messages for the LLM call.
 * Respects token budgets for each context section.
 */
export function assembleContext(options: {
  provider: LLMProvider;
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: Message[];
  relevantMemories?: string[];
  activeJobs?: Array<{ id: string; status: string; description?: string }>;
  additionalContext?: string;
  maxContextMessages?: number;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const provider = options.provider;

  // 1. System prompt (already budgeted during construction)
  messages.push({ role: 'system', content: options.systemPrompt });

  // 2. Relevant memories (up to MEMORY_TOKEN_BUDGET, top-k=DEFAULT_MEMORY_TOP_K)
  // Stubbed for v0.1 — Journal not yet available
  if (options.relevantMemories && options.relevantMemories.length > 0) {
    const memories = options.relevantMemories.slice(0, DEFAULT_MEMORY_TOP_K);
    let memoriesText = 'Relevant past context:\n';
    let memoriesTokens = 0;

    for (const memory of memories) {
      const memTokens = provider.estimateTokens(memory);
      if (memoriesTokens + memTokens > MEMORY_TOKEN_BUDGET) {
        break;
      }
      memoriesText += `- ${memory}\n`;
      memoriesTokens += memTokens;
    }

    if (memoriesTokens > 0) {
      messages.push({ role: 'system', content: memoriesText });
    }
  }

  // 3. Active job state
  if (options.activeJobs && options.activeJobs.length > 0) {
    const jobsText = 'Currently active jobs:\n' +
      options.activeJobs
        .map((j) => `- Job ${j.id}: ${j.status}${j.description ? ` — ${j.description}` : ''}`)
        .join('\n');
    messages.push({ role: 'system', content: jobsText });
  }

  // 4. Conversation history (up to CONVERSATION_TOKEN_BUDGET, last N messages)
  if (options.conversationHistory && options.conversationHistory.length > 0) {
    const maxMessages = options.maxContextMessages ?? DEFAULT_CONTEXT_MESSAGES;
    const recent = options.conversationHistory.slice(-maxMessages);
    let historyTokens = 0;

    // Build from most recent, respecting budget
    const historyMessages: ChatMessage[] = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounds checked by loop
      const msg = recent[i]!;
      const msgTokens = provider.estimateTokens(msg.content);
      if (historyTokens + msgTokens > CONVERSATION_TOKEN_BUDGET) {
        break;
      }
      historyMessages.unshift({
        role: msg.role === 'system' ? 'system' : msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
      historyTokens += msgTokens;
    }

    messages.push(...historyMessages);
  }

  // 5. Additional context (retry instructions, etc.)
  if (options.additionalContext) {
    messages.push({ role: 'system', content: options.additionalContext });
  }

  // 6. Current user message (always last)
  messages.push({ role: 'user', content: options.userMessage });

  return messages;
}

// ---------------------------------------------------------------------------
// Collect streaming response
// ---------------------------------------------------------------------------

/**
 * Collect all chunks from a streaming LLM response into a single string.
 * Tracks total token usage.
 */
async function collectStreamResponse(
  stream: AsyncIterable<ChatChunk>,
): Promise<{ content: string; usage: { inputTokens?: number; outputTokens?: number } }> {
  let content = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const chunk of stream) {
    content += chunk.content;

    if (chunk.usage) {
      if (chunk.usage.inputTokens !== undefined) {
        inputTokens = chunk.usage.inputTokens;
      }
      if (chunk.usage.outputTokens !== undefined) {
        outputTokens = chunk.usage.outputTokens;
      }
    }
  }

  return { content, usage: { inputTokens, outputTokens } };
}

// ---------------------------------------------------------------------------
// Build fast-path verification context
// ---------------------------------------------------------------------------

function buildVerificationContext(
  gearCatalog?: GearManifest[],
): FastPathVerificationContext {
  const registeredGearNames: string[] = [];
  const registeredActionNames: string[] = [];

  if (gearCatalog) {
    for (const gear of gearCatalog) {
      registeredGearNames.push(gear.id);
      registeredGearNames.push(gear.name);
      for (const action of gear.actions) {
        registeredActionNames.push(action.name);
      }
    }
  }

  return { registeredGearNames, registeredActionNames };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * Planner — generates execution plans or direct text responses.
 *
 * The planner:
 * 1. Assembles context with token budgets
 * 2. Calls the LLM provider
 * 3. Detects fast-path vs full-path via structural analysis
 * 4. Verifies fast-path responses for false classifications
 * 5. Handles failures via the failure handler
 * 6. Enforces per-job token budgets
 * 7. Logs all LLM API calls to the audit trail
 */
export class Planner {
  private readonly provider: LLMProvider;
  private readonly model: string;
  private readonly temperature: number;
  private readonly gearCatalog: GearManifest[];
  private readonly userPreferences?: string;
  private readonly logger: PlannerLogger;
  private readonly auditWriter: PlannerAuditWriter;
  private readonly maxContextMessages: number;
  private readonly jobTokenBudget: number;
  private readonly verificationContext: FastPathVerificationContext;

  constructor(options: PlannerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.temperature = options.temperature ?? 0.3;
    this.gearCatalog = options.gearCatalog ?? [];
    this.userPreferences = options.userPreferences;
    this.logger = options.logger ?? noopLogger;
    this.auditWriter = options.auditWriter ?? noopAuditWriter;
    this.maxContextMessages = options.maxContextMessages ?? DEFAULT_CONTEXT_MESSAGES;
    this.jobTokenBudget = options.jobTokenBudget ?? DEFAULT_JOB_TOKEN_BUDGET;
    this.verificationContext = buildVerificationContext(this.gearCatalog);
  }

  /**
   * Generate a plan or direct response for a user message.
   *
   * @returns PlanResult on success, PlanError on failure
   */
  async generatePlan(request: PlanRequest): Promise<PlanResult | PlanError> {
    const failureState = request.failureState ?? createFailureState();
    const cumulativeTokens = request.cumulativeTokens ?? 0;

    // Determine which model to use — adaptive selection (Phase 11.1)
    const effectiveModel = request.modelOverride ?? this.model;

    // Enforce per-job token budget (Section 6.2 LLM10)
    if (cumulativeTokens >= this.jobTokenBudget) {
      this.logger.warn('Per-job token budget exceeded', {
        jobId: request.jobId,
        cumulativeTokens,
        budget: this.jobTokenBudget,
      });
      return {
        type: 'budget_exceeded',
        message: `Per-job token budget exceeded: ${cumulativeTokens} / ${this.jobTokenBudget} tokens used`,
        action: 'fail',
        failureState,
      };
    }

    // Build system prompt
    const systemPrompt = buildSystemPrompt({
      provider: this.provider,
      gearCatalog: this.gearCatalog,
      userPreferences: this.userPreferences,
      forceFullPath: request.forceFullPath,
    });

    // Assemble context messages
    const messages = assembleContext({
      provider: this.provider,
      systemPrompt,
      userMessage: request.userMessage,
      conversationHistory: request.conversationHistory,
      relevantMemories: request.relevantMemories,
      activeJobs: request.activeJobs,
      additionalContext: request.additionalContext,
      maxContextMessages: this.maxContextMessages,
    });

    // Log LLM API call to audit trail (Section 7.3)
    // Includes content sent per architecture requirement: "Every external LLM call
    // logged in audit trail including content sent"
    await this.auditWriter.write({
      actor: 'scout',
      action: 'llm.call',
      riskLevel: 'low',
      jobId: request.jobId,
      details: {
        model: effectiveModel,
        modelOverride: request.modelOverride ?? null,
        provider: this.provider.name,
        messageCount: messages.length,
        estimatedInputTokens: messages.reduce(
          (sum, m) => sum + this.provider.estimateTokens(m.content),
          0,
        ),
        contentSent: messages.map((m) => ({ role: m.role, content: m.content })),
      },
    });

    this.logger.debug('Calling LLM provider', {
      jobId: request.jobId,
      model: effectiveModel,
      modelOverride: request.modelOverride ?? null,
      messageCount: messages.length,
      forceFullPath: request.forceFullPath,
    });

    // Call the LLM
    let raw: string;
    let usage: { inputTokens?: number; outputTokens?: number };

    try {
      const stream = this.provider.chat({
        model: effectiveModel,
        messages,
        temperature: this.temperature,
        signal: request.signal,
      });

      const result = await collectStreamResponse(stream);
      raw = result.content;
      usage = result.usage;
    } catch (error: unknown) {
      // Provider API errors are handled by Axis error classification (5.1.11)
      this.logger.error('LLM call failed', {
        jobId: request.jobId,
        model: effectiveModel,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Log response to audit trail (Section 7.3)
    await this.auditWriter.write({
      actor: 'scout',
      action: 'llm.response',
      riskLevel: 'low',
      jobId: request.jobId,
      details: {
        model: effectiveModel,
        responseLength: raw.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    });

    // Detect path and classify response
    return this.processResponse(raw, usage, request, failureState);
  }

  /**
   * Process the raw LLM response: detect path, verify, handle failures.
   */
  private processResponse(
    raw: string,
    usage: { inputTokens?: number; outputTokens?: number },
    request: PlanRequest,
    failureState: PlanningFailureState,
  ): PlanResult | PlanError {
    // Check for empty/nonsensical before path detection
    const trimmed = raw.trim();

    // Detect path type (structural determination)
    const detection = detectAndVerifyPath(trimmed, this.verificationContext);

    if (detection.path === 'full' && detection.plan) {
      return this.handleFullPath(detection, usage, request, failureState);
    }

    // Fast path response
    return this.handleFastPath(detection, raw, usage, request, failureState);
  }

  /**
   * Handle a full-path (execution plan) response.
   */
  private handleFullPath(
    detection: PathDetectionResult,
    usage: { inputTokens?: number; outputTokens?: number },
    request: PlanRequest,
    failureState: PlanningFailureState,
  ): PlanResult | PlanError {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by caller's plan check
    const plan = detection.plan!;

    // Check for repetitive output
    const repetitive = checkRepetitiveOutput(plan, failureState);
    if (repetitive) {
      return {
        type: 'failure',
        message: repetitive.message,
        action: repetitive.action,
        failureState,
      };
    }

    // Set plan ID and jobId if not already set
    if (!plan.id) {
      plan.id = generateId();
    }
    if (!plan.jobId) {
      plan.jobId = request.jobId;
    }

    this.logger.info('Generated execution plan', {
      jobId: request.jobId,
      planId: plan.id,
      stepCount: plan.steps.length,
      journalSkip: plan.journalSkip,
    });

    return {
      path: 'full',
      plan,
      usage,
      failureState,
    };
  }

  /**
   * Handle a fast-path (text) response.
   */
  private handleFastPath(
    detection: PathDetectionResult,
    raw: string,
    usage: { inputTokens?: number; outputTokens?: number },
    request: PlanRequest,
    failureState: PlanningFailureState,
  ): PlanResult | PlanError {
    // If force full path was requested but we got text, it's a failure
    if (request.forceFullPath) {
      // Check if this is actually a malformed plan attempt
      const jsonError = this.tryExtractJsonError(raw);
      if (jsonError) {
        const classification = classifyFailure(raw, failureState, jsonError);
        incrementRetryCount(failureState, classification.type);
        return {
          type: 'failure',
          message: classification.message,
          action: classification.action,
          failureState,
        };
      }

      // Model refused or produced text when plan was required
      const classification = classifyFailure(raw, failureState);
      if (classification.action !== 'fail') {
        incrementRetryCount(failureState, classification.type);
      }
      return {
        type: 'failure',
        message: `Expected ExecutionPlan JSON but received plain text: ${classification.message}`,
        action: classification.action,
        failureState,
      };
    }

    // Fast-path verification failed — needs re-routing
    if (detection.verificationFailure) {
      this.logger.warn('Fast-path verification failed', {
        jobId: request.jobId,
        reason: detection.verificationFailure,
      });
      return {
        path: 'fast',
        text: detection.text,
        usage,
        failureState,
        requiresReroute: true,
        rerouteReason: detection.verificationFailure,
      };
    }

    this.logger.info('Fast-path response', {
      jobId: request.jobId,
      responseLength: raw.length,
    });

    return {
      path: 'fast',
      text: detection.text ?? raw,
      usage,
      failureState,
    };
  }

  /**
   * Try to extract a JSON parse error from raw text that looks like
   * a failed attempt at JSON output.
   */
  private tryExtractJsonError(raw: string): string | undefined {
    const trimmed = raw.trim();

    // If it starts with { or [ but isn't valid JSON, it's a parse error
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed);
        // Valid JSON but not an ExecutionPlan — check for missing fields
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (!parsed['id'] || !parsed['jobId'] || !Array.isArray(parsed['steps'])) {
          return 'JSON object does not conform to ExecutionPlan schema: missing required fields (id, jobId, steps)';
        }
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }

    // Check for JSON wrapped in markdown code blocks
    const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
    if (codeBlockMatch?.[1]) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1]) as Record<string, unknown>;
        // It parsed but was wrapped — indicate the wrapping issue
        if (parsed['steps']) {
          return 'ExecutionPlan JSON was wrapped in markdown code blocks. Output ONLY raw JSON without any surrounding text or code blocks.';
        }
      } catch {
        // Not valid JSON inside code block either
      }
    }

    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new Planner instance.
 */
export function createPlanner(options: PlannerOptions): Planner {
  return new Planner(options);
}
