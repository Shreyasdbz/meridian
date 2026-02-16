// @meridian/scout — Fast path vs full path detection (Section 4.3)
//
// Structural determination: plain text = fast path, ExecutionPlan JSON = full path.
// Axis verification catches cases where Scout may have taken action-like behavior
// without producing a proper plan.

import type { ExecutionPlan } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PathType = 'fast' | 'full';

export interface PathDetectionResult {
  /** Whether this is a fast-path or full-path response. */
  path: PathType;
  /** Parsed execution plan (only present for full-path). */
  plan?: ExecutionPlan;
  /** Plain text response (only present for fast-path). */
  text?: string;
  /** If fast-path verification failed, the reason. */
  verificationFailure?: string;
}

export interface FastPathVerificationContext {
  /** Known Gear names from the registry. */
  registeredGearNames: string[];
  /** Known action identifiers from the registry. */
  registeredActionNames: string[];
}

// ---------------------------------------------------------------------------
// Deferred-action language patterns (Section 4.3)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate Scout may have "acted" without producing a plan.
 * These are checked against fast-path (text) responses to catch
 * false fast-path classifications.
 */
const DEFERRED_ACTION_PATTERNS: RegExp[] = [
  /I've gone ahead and\b/i,
  /I've already set up\b/i,
  /I've already\b/i,
  /I went ahead and\b/i,
  /Done! I created\b/i,
  /Done! I've\b/i,
  /I've created\b/i,
  /I've set up\b/i,
  /I've configured\b/i,
  /I've installed\b/i,
  /I've deleted\b/i,
  /I've removed\b/i,
  /I've updated\b/i,
  /I've modified\b/i,
  /I've sent\b/i,
  /I've executed\b/i,
  /I've deployed\b/i,
  /I've scheduled\b/i,
  /I've written\b/i,
  /I took the liberty of\b/i,
  /I just went ahead\b/i,
  /I made the changes\b/i,
  /I completed the\b/i,
  /Successfully (?:created|deleted|modified|sent|executed|deployed|written|installed|configured)\b/i,
  /The file has been (?:created|deleted|modified|written)\b/i,
  /The (?:email|message) has been sent\b/i,
  /Your (?:file|document|project) has been (?:created|set up|configured)\b/i,
];

/**
 * Patterns indicating Scout falsely claims inability to perform actions
 * that available Gear plugins can handle. When these appear in a fast-path
 * response and relevant Gear is registered, the response should be rerouted
 * to force a full-path ExecutionPlan.
 */
const INABILITY_PATTERNS: RegExp[] = [
  /I (?:don't|do not|cannot|can't) have (?:direct )?access to/i,
  /I (?:don't|do not|cannot|can't) (?:access|read|write|browse|view|see|list|open|check|search)/i,
  /I'm (?:unable|not able) to (?:access|read|write|browse|view|list|open|check|search)/i,
  /I (?:don't|do not) have (?:the ability|the capability|filesystem|file system|internet|web|shell) access/i,
  /(?:no|don't have) access to (?:your|the) (?:file ?system|files|folders|directories|computer|machine|system)/i,
  /(?:can't|cannot) (?:interact with|access) (?:your|the) (?:local|file ?system|computer|machine)/i,
  /as an AI,? I (?:don't|cannot|can't)/i,
  /I'm (?:just )?(?:a language model|an AI|a text-based)/i,
];

// ---------------------------------------------------------------------------
// Plan structure detection
// ---------------------------------------------------------------------------

/**
 * JSON patterns that resemble an ExecutionPlan structure.
 * Used to detect when a text response contains embedded plan JSON.
 */
const PLAN_JSON_PATTERN = /\{\s*"(?:id|jobId|steps)"\s*:/;
const STEP_JSON_PATTERN = /\{\s*"(?:gear|action|riskLevel)"\s*:/;

// ---------------------------------------------------------------------------
// Core detection logic
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed JSON object conforms to the ExecutionPlan schema.
 */
function validatePlanShape(parsed: Record<string, unknown>): ExecutionPlan | undefined {
  if (
    typeof parsed['id'] !== 'string' ||
    typeof parsed['jobId'] !== 'string' ||
    !Array.isArray(parsed['steps'])
  ) {
    return undefined;
  }

  const steps = parsed['steps'] as Record<string, unknown>[];
  for (const step of steps) {
    if (
      typeof step['id'] !== 'string' ||
      typeof step['gear'] !== 'string' ||
      typeof step['action'] !== 'string' ||
      typeof step['parameters'] !== 'object' ||
      step['parameters'] === null ||
      typeof step['riskLevel'] !== 'string'
    ) {
      return undefined;
    }
  }

  return parsed as unknown as ExecutionPlan;
}

/**
 * Attempt to parse raw LLM output as an ExecutionPlan.
 * Returns the plan if valid JSON with required plan fields, undefined otherwise.
 *
 * Handles three formats:
 * 1. Pure JSON starting with {
 * 2. JSON wrapped in markdown code blocks (```json ... ```)
 * 3. Text followed by a JSON code block (extracts the JSON)
 */
export function tryParseExecutionPlan(raw: string): ExecutionPlan | undefined {
  const trimmed = raw.trim();

  // Format 1: Pure JSON starting with {
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return validatePlanShape(parsed);
    } catch {
      return undefined;
    }
  }

  // Format 2 & 3: JSON wrapped in or preceded by text with markdown code blocks
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  if (codeBlockMatch?.[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]) as Record<string, unknown>;
      return validatePlanShape(parsed);
    } catch {
      return undefined;
    }
  }

  // Format: Text that contains a raw JSON object (find first { and try to parse from there)
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart > 0) {
    const jsonCandidate = trimmed.slice(jsonStart);
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      return validatePlanShape(parsed);
    } catch {
      // JSON might be truncated or invalid — give up
      return undefined;
    }
  }

  return undefined;
}

/**
 * Detect whether raw LLM output is a fast-path (text) or full-path (plan) response.
 *
 * Path selection is structural — determined by the shape of Scout's output:
 * - If it parses as a valid ExecutionPlan JSON → full path
 * - Otherwise → fast path (subject to verification)
 */
export function detectPath(raw: string): PathDetectionResult {
  const plan = tryParseExecutionPlan(raw);

  if (plan) {
    return { path: 'full', plan };
  }

  return { path: 'fast', text: raw };
}

/**
 * Verify that a fast-path response is genuinely conversational and does not
 * contain action-like behavior that should have been a full-path plan.
 *
 * Four checks (Section 4.3):
 * 1. No JSON structures resembling execution plans
 * 2. No references to registered Gear names or action identifiers
 * 3. No deferred-action language patterns
 * 4. No false inability claims (saying "I can't access" when Gear can)
 *
 * @returns null if verification passes, or a string describing the failure reason
 */
export function verifyFastPath(
  text: string,
  context: FastPathVerificationContext,
): string | null {
  // Check 1: No JSON structures resembling execution plans
  if (PLAN_JSON_PATTERN.test(text) || STEP_JSON_PATTERN.test(text)) {
    return 'Response contains JSON structures resembling an execution plan';
  }

  // Check 2: No references to registered Gear names or action identifiers
  for (const gearName of context.registeredGearNames) {
    // Use word boundary matching to avoid false positives on partial matches.
    // Escape special regex chars in Gear names.
    const escaped = gearName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    if (pattern.test(text)) {
      return `Response references registered Gear name: "${gearName}"`;
    }
  }

  for (const actionName of context.registeredActionNames) {
    const escaped = actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    if (pattern.test(text)) {
      return `Response references registered action: "${actionName}"`;
    }
  }

  // Check 3: No deferred-action language patterns
  for (const pattern of DEFERRED_ACTION_PATTERNS) {
    if (pattern.test(text)) {
      return `Response contains deferred-action language: "${text.match(pattern)?.[0]}"`;
    }
  }

  // Check 4: No false inability claims when Gear plugins are available
  // If Scout says "I can't access files" but file-manager Gear is registered,
  // reroute to force a plan that uses the Gear.
  if (context.registeredGearNames.length > 0) {
    for (const pattern of INABILITY_PATTERNS) {
      if (pattern.test(text)) {
        return `Response claims inability but Gear plugins are available: "${text.match(pattern)?.[0]}"`;
      }
    }
  }

  return null;
}

/**
 * Full path detection pipeline: detect path type, then verify fast-path
 * responses if applicable.
 *
 * If fast-path verification fails, the result includes the failure reason
 * so the caller can re-route to Scout with full-path instructions.
 */
export function detectAndVerifyPath(
  raw: string,
  context: FastPathVerificationContext,
): PathDetectionResult {
  const result = detectPath(raw);

  if (result.path === 'full') {
    return result;
  }

  const failure = verifyFastPath(result.text ?? '', context);
  if (failure) {
    return {
      path: 'fast',
      text: result.text,
      verificationFailure: failure,
    };
  }

  return result;
}
