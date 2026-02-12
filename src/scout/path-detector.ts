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
 * Attempt to parse raw LLM output as an ExecutionPlan.
 * Returns the plan if valid JSON with required plan fields, undefined otherwise.
 */
export function tryParseExecutionPlan(raw: string): ExecutionPlan | undefined {
  const trimmed = raw.trim();

  // Must start with { to be a JSON object
  if (!trimmed.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // Validate required ExecutionPlan fields
    if (
      typeof parsed['id'] !== 'string' ||
      typeof parsed['jobId'] !== 'string' ||
      !Array.isArray(parsed['steps'])
    ) {
      return undefined;
    }

    // Validate that each step has required fields
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
  } catch {
    return undefined;
  }
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
 * Three checks (Section 4.3):
 * 1. No JSON structures resembling execution plans
 * 2. No references to registered Gear names or action identifiers
 * 3. No deferred-action language patterns
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
