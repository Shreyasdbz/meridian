// @meridian/journal — Reflector: LLM-based post-task analysis (Phase 10.2)
//
// Analyzes completed tasks using an LLM call pattern matching sentinel's
// llm-validator.ts. Runs async (does not block user response).
//
// Includes:
// - PII reduction (2-pass: regex + LLM review)
// - Instruction/data classifier
// - Journal-skip logic

import type {
  ChatChunk,
  ChatMessage,
  ExecutionPlan,
  JobStatus,
  LLMProvider,
} from '@meridian/shared';
import { LLMProviderError } from '@meridian/shared';

import { REFLECTION_V1 } from './prompts/reflection-v1.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReflectorConfig {
  provider: LLMProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  logger?: ReflectorLogger;
}

export interface ReflectorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface ReflectionInput {
  plan: ExecutionPlan;
  status: JobStatus;
  userMessage: string;
  assistantResponse: string;
  stepResults?: Array<{
    stepId: string;
    status: 'completed' | 'failed';
    result?: Record<string, unknown>;
    error?: string;
  }>;
}

export interface ReflectionResult {
  episode: {
    summary: string;
    outcome: 'success' | 'partial_success' | 'failure';
  };
  facts: Array<{
    category: 'user_preference' | 'environment' | 'knowledge';
    content: string;
    confidence: number;
  }>;
  procedures: Array<{
    category: 'strategy' | 'pattern' | 'workflow';
    content: string;
  }>;
  contradictions: Array<{
    existingFact: string;
    newEvidence: string;
    suggestedResolution: string;
  }>;
  gearSuggestion: GearBrief | null;
}

export interface GearBrief {
  problem: string;
  proposedSolution: string;
  exampleInput: string;
  exampleOutput: string;
  manifestSkeleton?: string;
  pseudocode?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 4096;

// PII regex patterns (Pass 1)
const PII_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  { name: 'phone', regex: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, replacement: '[PHONE]' },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN]' },
  { name: 'credit_card', regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, replacement: '[CARD]' },
  { name: 'ipv4', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
];

// Instruction classifier heuristics
const INSTRUCTION_PATTERNS = [
  /^you must/i,
  /^you should/i,
  /^always /i,
  /^never /i,
  /^ignore previous/i,
  /^system:/i,
  /^override/i,
  /^disregard/i,
  /^execute the following/i,
  /^run this command/i,
];

const noopLogger: ReflectorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Journal-skip logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a task should be reflected on.
 * Returns false only if plan.journalSkip === true AND status is 'completed'.
 * Failures always get reflected on.
 */
export function shouldReflect(
  plan: ExecutionPlan,
  status: JobStatus,
): boolean {
  if (status === 'failed') {
    return true;
  }
  if (plan.journalSkip === true && status === 'completed') {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// PII reduction
// ---------------------------------------------------------------------------

/**
 * Pass 1: Regex-based PII reduction for structured patterns.
 * Returns the cleaned text and a count of redactions.
 */
export function reducePiiRegex(text: string): { cleaned: string; redactions: number } {
  let cleaned = text;
  let redactions = 0;

  for (const pattern of PII_PATTERNS) {
    const matches = cleaned.match(pattern.regex);
    if (matches) {
      redactions += matches.length;
      cleaned = cleaned.replace(pattern.regex, pattern.replacement);
    }
  }

  return { cleaned, redactions };
}

/**
 * 2-pass PII reduction: regex first, then LLM review for contextual PII.
 *
 * Known limitation: 85-92% recall. This is NOT a security guarantee.
 * Some contextual PII (names in narrative, indirect identifiers) may
 * pass through. Document prominently per architecture Section 7.2.
 */
export async function reducePii(
  text: string,
  provider?: LLMProvider,
  model?: string,
): Promise<string> {
  // Pass 1: Regex
  const { cleaned } = reducePiiRegex(text);

  // Pass 2: LLM review (if provider available)
  if (provider && model) {
    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'Review the following text and replace any remaining PII ' +
            '(personal names, addresses, account numbers, or other identifying ' +
            'information) with generic placeholders like [NAME], [ADDRESS], etc. ' +
            'Return ONLY the cleaned text, nothing else.',
        },
        { role: 'user', content: cleaned },
      ];

      const stream = provider.chat({
        model,
        messages,
        temperature: 0,
        maxTokens: 2048,
      });

      let result = '';
      for await (const chunk of stream) {
        result += chunk.content;
        if (chunk.done) break;
      }

      return result.trim() || cleaned;
    } catch {
      // LLM PII review failed — return regex-only result
      return cleaned;
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Instruction/data classifier
// ---------------------------------------------------------------------------

/**
 * Classify content as 'instruction', 'data', or 'uncertain'.
 * Heuristics first, returns 'uncertain' for edge cases.
 *
 * Content classified as 'instruction' should be flagged, not stored directly.
 */
export function classifyContent(
  content: string,
): 'instruction' | 'data' | 'uncertain' {
  const trimmed = content.trim();

  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'instruction';
    }
  }

  // Check for common data patterns
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<')) {
    return 'data';
  }

  // Short content is more likely data
  if (trimmed.length < 20) {
    return 'data';
  }

  return 'uncertain';
}

// ---------------------------------------------------------------------------
// Reflector
// ---------------------------------------------------------------------------

export class Reflector {
  private readonly config: ReflectorConfig;
  private readonly logger: ReflectorLogger;

  constructor(config: ReflectorConfig) {
    this.config = config;
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Analyze a completed task and produce reflection results.
   * This runs async and should not block user interaction.
   */
  async reflect(input: ReflectionInput): Promise<ReflectionResult> {
    this.logger.debug('Starting reflection', {
      planId: input.plan.id,
      status: input.status,
      stepCount: input.plan.steps.length,
    });

    // Build the reflection context
    const context = this.buildReflectionContext(input);

    // Call LLM
    const messages: ChatMessage[] = [
      { role: 'system', content: REFLECTION_V1.content },
      { role: 'user', content: context },
    ];

    let responseText: string;
    try {
      const stream = this.config.provider.chat({
        model: this.config.model,
        messages,
        temperature: this.config.temperature ?? DEFAULT_TEMPERATURE,
        maxTokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      });

      responseText = await collectStreamResponse(stream);
    } catch (error) {
      this.logger.error('Reflection LLM call failed', {
        planId: input.plan.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LLMProviderError(
        `Reflection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Parse the response
    const result = this.parseReflectionResponse(responseText);

    // PII reduction on all extracted content (2-pass: regex + LLM review)
    result.episode.summary = (await reducePii(
      result.episode.summary, this.config.provider, this.config.model,
    )).trim();
    for (const fact of result.facts) {
      fact.content = (await reducePii(
        fact.content, this.config.provider, this.config.model,
      )).trim();
    }
    for (const proc of result.procedures) {
      proc.content = (await reducePii(
        proc.content, this.config.provider, this.config.model,
      )).trim();
    }

    // Flag instruction-like content
    result.facts = result.facts.filter((f) => {
      const classification = classifyContent(f.content);
      if (classification === 'instruction') {
        this.logger.warn('Instruction-like content filtered from facts', {
          content: f.content.slice(0, 100),
        });
        return false;
      }
      return true;
    });

    this.logger.info('Reflection complete', {
      planId: input.plan.id,
      factsExtracted: result.facts.length,
      proceduresExtracted: result.procedures.length,
      contradictions: result.contradictions.length,
      hasGearSuggestion: result.gearSuggestion !== null,
    });

    return result;
  }

  private buildReflectionContext(input: ReflectionInput): string {
    const parts: string[] = [];

    parts.push(`## Task Status: ${input.status}`);
    parts.push(`## User Request:\n${input.userMessage}`);
    parts.push(`## Assistant Response:\n${input.assistantResponse}`);

    if (input.plan.steps.length > 0) {
      parts.push('## Execution Plan:');
      for (const step of input.plan.steps) {
        parts.push(`- Step ${step.id}: ${step.gear}.${step.action} (risk: ${step.riskLevel})`);
        if (step.description) {
          parts.push(`  Description: ${step.description}`);
        }
      }
    }

    if (input.stepResults && input.stepResults.length > 0) {
      parts.push('## Step Results:');
      for (const sr of input.stepResults) {
        parts.push(`- ${sr.stepId}: ${sr.status}`);
        if (sr.error) {
          parts.push(`  Error: ${sr.error}`);
        }
      }
    }

    return parts.join('\n\n');
  }

  private parseReflectionResponse(responseText: string): ReflectionResult {
    const jsonText = extractJson(responseText);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new LLMProviderError(
        `Reflection response is not valid JSON: ${responseText.slice(0, 200)}`,
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new LLMProviderError('Reflection response is not a JSON object');
    }

    const obj = parsed as Record<string, unknown>;

    // Validate and extract with defaults
    const episode = obj['episode'] as Record<string, unknown> | undefined;
    const facts = (obj['facts'] as unknown[] | undefined) ?? [];
    const procedures = (obj['procedures'] as unknown[] | undefined) ?? [];
    const contradictions = (obj['contradictions'] as unknown[] | undefined) ?? [];
    const gearSuggestion = obj['gearSuggestion'] as Record<string, unknown> | null | undefined;

    return {
      episode: {
        summary: (episode?.['summary'] as string | undefined) ?? 'No summary provided',
        outcome: (episode?.['outcome'] as 'success' | 'partial_success' | 'failure' | undefined) ?? 'success',
      },
      facts: facts
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => ({
          category: (f['category'] as 'user_preference' | 'environment' | 'knowledge' | undefined) ?? 'knowledge',
          content: (f['content'] as string | undefined) ?? '',
          confidence: typeof f['confidence'] === 'number' ? f['confidence'] : 0.7,
        }))
        .filter((f) => f.content.length > 0 && f.confidence >= 0.5),
      procedures: procedures
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map((p) => ({
          category: (p['category'] as 'strategy' | 'pattern' | 'workflow' | undefined) ?? 'pattern',
          content: (p['content'] as string | undefined) ?? '',
        }))
        .filter((p) => p.content.length > 0),
      contradictions: contradictions
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          existingFact: (c['existingFact'] as string | undefined) ?? '',
          newEvidence: (c['newEvidence'] as string | undefined) ?? '',
          suggestedResolution: (c['suggestedResolution'] as string | undefined) ?? '',
        })),
      gearSuggestion: gearSuggestion && typeof gearSuggestion === 'object'
        ? {
            problem: (gearSuggestion['problem'] as string | undefined) ?? '',
            proposedSolution: (gearSuggestion['proposedSolution'] as string | undefined) ?? '',
            exampleInput: (gearSuggestion['exampleInput'] as string | undefined) ?? '',
            exampleOutput: (gearSuggestion['exampleOutput'] as string | undefined) ?? '',
            manifestSkeleton: gearSuggestion['manifestSkeleton'] as string | undefined,
            pseudocode: gearSuggestion['pseudocode'] as string | undefined,
          }
        : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectStreamResponse(stream: AsyncIterable<ChatChunk>): Promise<string> {
  let content = '';
  for await (const chunk of stream) {
    content += chunk.content;
    if (chunk.done) break;
  }
  return content;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}
