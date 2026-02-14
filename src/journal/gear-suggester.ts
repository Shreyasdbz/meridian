// @meridian/journal — GearSuggester: produces structured Gear briefs (Phase 10.2)
//
// Analyzes reflection results and produces Gear briefs for recurring problems.
// Briefs are NOT executable code — they are structured descriptions saved to
// workspace/gear/ with origin: "journal". Human review required before
// implementation.
//
// Per architecture v0.4 spec: briefs only, not code generation.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GearBrief, ReflectionResult } from './reflector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GearSuggesterOptions {
  workspaceDir: string;
  logger?: GearSuggesterLogger;
}

export interface GearSuggesterLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface SavedGearBrief {
  brief: GearBrief;
  filePath: string;
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEAR_BRIEF_DIR = 'gear';

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: GearSuggesterLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// GearSuggester
// ---------------------------------------------------------------------------

export class GearSuggester {
  private readonly workspaceDir: string;
  private readonly logger: GearSuggesterLogger;

  constructor(options: GearSuggesterOptions) {
    this.workspaceDir = options.workspaceDir;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Process a reflection result and save any Gear brief to the workspace.
   * Returns the saved brief, or null if no suggestion was present.
   */
  processSuggestion(reflection: ReflectionResult): SavedGearBrief | null {
    if (!reflection.gearSuggestion) {
      this.logger.debug('No Gear suggestion in reflection');
      return null;
    }

    const brief = reflection.gearSuggestion;

    // Validate the brief has meaningful content
    if (!isValidBrief(brief)) {
      this.logger.warn('Invalid Gear brief — missing required fields', {
        problem: brief.problem.slice(0, 50),
      });
      return null;
    }

    return this.saveBrief(brief);
  }

  /**
   * Save a Gear brief to the workspace directory.
   */
  saveBrief(brief: GearBrief): SavedGearBrief {
    const briefDir = join(this.workspaceDir, GEAR_BRIEF_DIR);
    mkdirSync(briefDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    const slug = slugify(brief.problem);
    const fileName = `brief-${timestamp}-${rand}-${slug}.json`;
    const filePath = join(briefDir, fileName);

    const createdAt = new Date().toISOString();
    const briefPayload: Record<string, string> = {
      problem: brief.problem,
      proposedSolution: brief.proposedSolution,
      exampleInput: brief.exampleInput,
      exampleOutput: brief.exampleOutput,
    };
    if (brief.manifestSkeleton) {
      briefPayload['manifestSkeleton'] = brief.manifestSkeleton;
    }
    if (brief.pseudocode) {
      briefPayload['pseudocode'] = brief.pseudocode;
    }

    const document = {
      origin: 'journal',
      createdAt,
      status: 'proposed',
      brief: briefPayload,
    };

    writeFileSync(filePath, JSON.stringify(document, null, 2), 'utf-8');

    this.logger.info('Gear brief saved', {
      filePath,
      problem: brief.problem.slice(0, 80),
    });

    return {
      brief,
      filePath,
      savedAt: document.createdAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a Gear brief has all required non-empty fields.
 */
export function isValidBrief(brief: GearBrief): boolean {
  return (
    brief.problem.trim().length > 0 &&
    brief.proposedSolution.trim().length > 0 &&
    brief.exampleInput.trim().length > 0 &&
    brief.exampleOutput.trim().length > 0
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a filesystem-safe slug from text.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
