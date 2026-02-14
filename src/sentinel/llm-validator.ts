// @meridian/sentinel — LLM-based plan validator (Phase 9.1)
//
// Upgrades Sentinel from rule-based to full dual-LLM pipeline.
// Uses an independently configured LLM provider/model to evaluate
// execution plans against validation categories (Section 5.3.2).
//
// INFORMATION BARRIER: The system prompt MUST NOT include:
// - The user's original message
// - Journal data (memories, reflections)
// - Gear catalog information
// Only the stripped execution plan and system policies are sent.
//
// Architecture references:
// - Section 5.3 (Sentinel — Safety Validator)
// - Section 5.3.2 (Validation Categories)
// - Section 5.3.6 (Sentinel Configuration)
// - Section 5.3.7 (Cost Implications — plan stripping)

import type {
  ChatChunk,
  ChatMessage,
  ExecutionPlan,
  LLMProvider,
  RiskLevel,
  StepValidation,
  StepValidationVerdict,
  ValidationResult,
  ValidationVerdict,
} from '@meridian/shared';
import { generateId, LLMProviderError } from '@meridian/shared';

import type { StrippedExecutionPlan } from './plan-stripper.js';
import { stripPlan } from './plan-stripper.js';
import { VALIDATION_V1 } from './prompts/validation-v1.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the LLM-based validator.
 */
export interface LLMValidatorConfig {
  /** LLM provider instance for Sentinel validation. */
  provider: LLMProvider;
  /** Model to use for validation. */
  model: string;
  /** Temperature for validation calls. Default: 0.1 (low for deterministic safety). */
  temperature?: number;
  /** Maximum tokens for the validation response. Default: 4096. */
  maxTokens?: number;
  /** Logger for validation events. */
  logger?: LLMValidatorLogger;
}

/**
 * Logger interface for LLM validator events.
 */
export interface LLMValidatorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Same-provider warning details.
 */
export interface SameProviderWarning {
  sentinelProvider: string;
  scoutProvider: string;
  message: string;
}

/**
 * Raw LLM validation response — the structured JSON we expect from the LLM.
 */
export interface LLMValidationResponse {
  verdict: ValidationVerdict;
  overallRisk: RiskLevel;
  reasoning: string;
  stepResults: LLMStepResult[];
  suggestedRevisions?: string;
}

/**
 * Per-step result from the LLM.
 */
interface LLMStepResult {
  stepId: string;
  verdict: StepValidationVerdict;
  category: string;
  riskLevel: RiskLevel;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Validation categories from Section 5.3.2.
 * Fully assessable: security, privacy, financial, policy_compliance, composite_risk
 * Partially assessable: ethical, legal
 *
 * These are documented here for reference; the system prompt lists them for the LLM.
 */
// security, privacy, financial, policy_compliance, composite_risk, ethical, legal

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: LLMValidatorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// System prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for Sentinel's LLM validation.
 *
 * INFORMATION BARRIER: This prompt MUST NOT include:
 * - The user's original message
 * - Journal data
 * - Gear catalog
 * - Any context that could be used to manipulate the validator
 */
export function buildSystemPrompt(): string {
  return VALIDATION_V1.content;
}

/**
 * Build the user message containing the stripped plan for evaluation.
 */
export function buildValidationMessage(
  strippedPlan: StrippedExecutionPlan,
): string {
  return `Review the following execution plan for safety:\n\n${JSON.stringify(strippedPlan, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Valid verdicts for validation.
 */
const VALID_PLAN_VERDICTS = new Set<string>([
  'approved',
  'rejected',
  'needs_user_approval',
  'needs_revision',
]);

const VALID_STEP_VERDICTS = new Set<string>([
  'approved',
  'rejected',
  'needs_user_approval',
]);

const VALID_RISK_LEVELS = new Set<string>([
  'low',
  'medium',
  'high',
  'critical',
]);

/**
 * Parse and validate the LLM's JSON response into a structured format.
 *
 * Extracts JSON from the response text (handles markdown code fences),
 * validates all fields, and returns a typed LLMValidationResponse.
 *
 * @throws {LLMProviderError} if the response cannot be parsed or is invalid
 */
export function parseValidationResponse(
  responseText: string,
): LLMValidationResponse {
  // Extract JSON from potentially wrapped response (markdown fences, etc.)
  const jsonText = extractJson(responseText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new LLMProviderError(
      `Sentinel LLM response is not valid JSON: ${responseText.slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LLMProviderError(
      'Sentinel LLM response is not a JSON object',
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Validate verdict
  if (!VALID_PLAN_VERDICTS.has(obj['verdict'] as string)) {
    throw new LLMProviderError(
      `Invalid verdict in Sentinel response: ${String(obj['verdict'])}`,
    );
  }

  // Validate overallRisk
  if (!VALID_RISK_LEVELS.has(obj['overallRisk'] as string)) {
    throw new LLMProviderError(
      `Invalid overallRisk in Sentinel response: ${String(obj['overallRisk'])}`,
    );
  }

  // Validate reasoning
  if (typeof obj['reasoning'] !== 'string') {
    throw new LLMProviderError(
      'Missing or invalid reasoning in Sentinel response',
    );
  }

  // Validate stepResults
  if (!Array.isArray(obj['stepResults'])) {
    throw new LLMProviderError(
      'Missing or invalid stepResults in Sentinel response',
    );
  }

  const stepResults = (obj['stepResults'] as unknown[]).map(
    (raw, index) => parseStepResult(raw, index),
  );

  return {
    verdict: obj['verdict'] as ValidationVerdict,
    overallRisk: obj['overallRisk'] as RiskLevel,
    reasoning: obj['reasoning'] as unknown as string,
    stepResults,
    suggestedRevisions:
      typeof obj['suggestedRevisions'] === 'string'
        ? obj['suggestedRevisions']
        : undefined,
  };
}

/**
 * Parse and validate a single step result from the LLM response.
 */
function parseStepResult(raw: unknown, index: number): LLMStepResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LLMProviderError(
      `Invalid stepResult at index ${index}: not an object`,
    );
  }

  const step = raw as Record<string, unknown>;

  if (typeof step['stepId'] !== 'string') {
    throw new LLMProviderError(
      `Invalid stepId at index ${index}: ${String(step['stepId'])}`,
    );
  }

  if (!VALID_STEP_VERDICTS.has(step['verdict'] as string)) {
    throw new LLMProviderError(
      `Invalid step verdict at index ${index}: ${String(step['verdict'])}`,
    );
  }

  if (typeof step['category'] !== 'string') {
    throw new LLMProviderError(
      `Invalid category at index ${index}: ${String(step['category'])}`,
    );
  }

  if (!VALID_RISK_LEVELS.has(step['riskLevel'] as string)) {
    throw new LLMProviderError(
      `Invalid riskLevel at index ${index}: ${String(step['riskLevel'])}`,
    );
  }

  if (typeof step['reasoning'] !== 'string') {
    throw new LLMProviderError(
      `Invalid reasoning at index ${index}: ${String(step['reasoning'])}`,
    );
  }

  const stepId = step['stepId'];
  const category = step['category'];
  const reasoning = step['reasoning'];

  return {
    stepId,
    verdict: step['verdict'] as StepValidationVerdict,
    category,
    riskLevel: step['riskLevel'] as RiskLevel,
    reasoning,
  };
}

/**
 * Extract JSON from a response that may be wrapped in markdown code fences.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();

  // Try extracting from ```json ... ``` fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Try finding JSON object directly (first { to last })
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  // Return as-is and let JSON.parse handle the error
  return trimmed;
}

// ---------------------------------------------------------------------------
// Same-provider warning
// ---------------------------------------------------------------------------

/**
 * Check if Scout and Sentinel are using the same LLM provider and generate
 * a warning if so. Per Section 5.3.6, using different providers is recommended
 * for maximum security.
 */
export function checkSameProvider(
  scoutProviderId: string,
  sentinelProviderId: string,
): SameProviderWarning | null {
  if (scoutProviderId === sentinelProviderId) {
    return {
      sentinelProvider: sentinelProviderId,
      scoutProvider: scoutProviderId,
      message:
        'Scout and Sentinel are using the same LLM provider. ' +
        'For maximum security, consider using different providers ' +
        '(e.g., Scout on Anthropic, Sentinel on OpenAI) to ensure ' +
        'a single provider compromise does not affect both.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM validation
// ---------------------------------------------------------------------------

/**
 * Collect all chunks from an LLM streaming response into a single string.
 */
async function collectStreamResponse(
  stream: AsyncIterable<ChatChunk>,
): Promise<string> {
  let content = '';
  for await (const chunk of stream) {
    content += chunk.content;
    if (chunk.done) break;
  }
  return content;
}

/**
 * Validate an execution plan using the configured LLM.
 *
 * This is the core function that:
 * 1. Strips the plan to required fields only (plan stripping)
 * 2. Constructs the system prompt (information barrier enforced)
 * 3. Sends the stripped plan to the LLM
 * 4. Parses and validates the structured response
 * 5. Returns a ValidationResult
 *
 * @param plan - The full execution plan from Scout
 * @param config - LLM validator configuration
 * @param signal - Abort signal for cancellation
 * @returns ValidationResult suitable for Axis routing
 */
export async function validatePlanWithLLM(
  plan: ExecutionPlan,
  config: LLMValidatorConfig,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  const logger = config.logger ?? noopLogger;

  // 1. Strip the plan to required fields only
  const strippedPlan = stripPlan(plan);

  logger.debug('Sending stripped plan to LLM for validation', {
    planId: plan.id,
    stepCount: strippedPlan.steps.length,
    model: config.model,
    providerId: config.provider.id,
  });

  // 2. Build messages (system prompt enforces information barrier)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildValidationMessage(strippedPlan) },
  ];

  // 3. Call the LLM
  let responseText: string;
  try {
    const stream = config.provider.chat({
      model: config.model,
      messages,
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      signal,
    });

    responseText = await collectStreamResponse(stream);
  } catch (error) {
    logger.error('LLM validation call failed', {
      planId: plan.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new LLMProviderError(
      `Sentinel LLM validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logger.debug('Received LLM validation response', {
    planId: plan.id,
    responseLength: responseText.length,
  });

  // 4. Parse the structured response
  const llmResult = parseValidationResponse(responseText);

  // 5. Convert to ValidationResult
  const stepResults: StepValidation[] = llmResult.stepResults.map((sr) => ({
    stepId: sr.stepId,
    verdict: sr.verdict,
    category: sr.category,
    riskLevel: sr.riskLevel,
    reasoning: sr.reasoning,
  }));

  const result: ValidationResult = {
    id: generateId(),
    planId: plan.id,
    verdict: llmResult.verdict,
    stepResults,
    overallRisk: llmResult.overallRisk,
    reasoning: llmResult.reasoning,
    suggestedRevisions: llmResult.suggestedRevisions,
    metadata: {
      validatedBy: 'llm',
      model: config.model,
      providerId: config.provider.id,
    },
  };

  logger.info('LLM plan validation complete', {
    planId: plan.id,
    verdict: result.verdict,
    overallRisk: result.overallRisk,
    stepCount: result.stepResults.length,
  });

  return result;
}
