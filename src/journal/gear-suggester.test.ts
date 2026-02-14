// @meridian/journal — GearSuggester tests (Phase 10.2)

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GearSuggester, isValidBrief } from './gear-suggester.js';
import type { ReflectionResult } from './reflector.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let suggester: GearSuggester;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `meridian-test-gear-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  suggester = new GearSuggester({ workspaceDir: testDir });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReflectionWithGear(): ReflectionResult {
  return {
    episode: { summary: 'Test', outcome: 'success' },
    facts: [],
    procedures: [],
    contradictions: [],
    gearSuggestion: {
      problem: 'Frequent CSV parsing needed',
      proposedSolution: 'A CSV parser Gear that reads CSV files and outputs JSON',
      exampleInput: 'name,age\nAlice,30\nBob,25',
      exampleOutput: '[{"name":"Alice","age":"30"},{"name":"Bob","age":"25"}]',
    },
  };
}

function createReflectionWithoutGear(): ReflectionResult {
  return {
    episode: { summary: 'Test', outcome: 'success' },
    facts: [],
    procedures: [],
    contradictions: [],
    gearSuggestion: null,
  };
}

// ---------------------------------------------------------------------------
// isValidBrief
// ---------------------------------------------------------------------------

describe('isValidBrief', () => {
  it('should accept a complete brief', () => {
    expect(isValidBrief({
      problem: 'CSV parsing',
      proposedSolution: 'CSV parser Gear',
      exampleInput: 'name,age',
      exampleOutput: '{"name":"value"}',
    })).toBe(true);
  });

  it('should reject a brief with empty problem', () => {
    expect(isValidBrief({
      problem: '',
      proposedSolution: 'Solution',
      exampleInput: 'input',
      exampleOutput: 'output',
    })).toBe(false);
  });

  it('should reject a brief with empty proposedSolution', () => {
    expect(isValidBrief({
      problem: 'Problem',
      proposedSolution: '  ',
      exampleInput: 'input',
      exampleOutput: 'output',
    })).toBe(false);
  });

  it('should reject a brief with empty exampleInput', () => {
    expect(isValidBrief({
      problem: 'Problem',
      proposedSolution: 'Solution',
      exampleInput: '',
      exampleOutput: 'output',
    })).toBe(false);
  });

  it('should reject a brief with empty exampleOutput', () => {
    expect(isValidBrief({
      problem: 'Problem',
      proposedSolution: 'Solution',
      exampleInput: 'input',
      exampleOutput: '',
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GearSuggester
// ---------------------------------------------------------------------------

describe('GearSuggester', () => {
  describe('processSuggestion', () => {
    it('should return null when no suggestion present', () => {
      const result = suggester.processSuggestion(createReflectionWithoutGear());
      expect(result).toBeNull();
    });

    it('should save a valid brief and return it', () => {
      const result = suggester.processSuggestion(createReflectionWithGear());

      expect(result).not.toBeNull();
      expect(result?.brief.problem).toBe('Frequent CSV parsing needed');
      expect(result?.filePath).toContain('brief-');
      expect(result?.savedAt).toBeTruthy();
    });

    it('should reject invalid briefs', () => {
      const reflection: ReflectionResult = {
        episode: { summary: 'Test', outcome: 'success' },
        facts: [],
        procedures: [],
        contradictions: [],
        gearSuggestion: {
          problem: '',
          proposedSolution: '',
          exampleInput: '',
          exampleOutput: '',
        },
      };

      const result = suggester.processSuggestion(reflection);
      expect(result).toBeNull();
    });
  });

  describe('saveBrief', () => {
    it('should create gear directory if it does not exist', () => {
      const brief = createReflectionWithGear().gearSuggestion as NonNullable<ReflectionResult['gearSuggestion']>;
      suggester.saveBrief(brief);

      expect(existsSync(join(testDir, 'gear'))).toBe(true);
    });

    it('should write a valid JSON file', () => {
      const brief = createReflectionWithGear().gearSuggestion as NonNullable<ReflectionResult['gearSuggestion']>;
      const saved = suggester.saveBrief(brief);

      const content = readFileSync(saved.filePath, 'utf-8');
      const parsed = JSON.parse(content) as Record<string, unknown>;

      expect(parsed['origin']).toBe('journal');
      expect(parsed['status']).toBe('proposed');
      expect(parsed['createdAt']).toBeTruthy();

      const briefObj = parsed['brief'] as Record<string, unknown>;
      expect(briefObj['problem']).toBe('Frequent CSV parsing needed');
      expect(briefObj['proposedSolution']).toContain('CSV');
      expect(briefObj['exampleInput']).toBeTruthy();
      expect(briefObj['exampleOutput']).toBeTruthy();
    });

    it('should create unique file names per brief', () => {
      const brief = createReflectionWithGear().gearSuggestion as NonNullable<ReflectionResult['gearSuggestion']>;
      const saved1 = suggester.saveBrief(brief);
      const saved2 = suggester.saveBrief(brief);

      expect(saved1.filePath).not.toBe(saved2.filePath);
    });

    it('should slugify the problem in the filename', () => {
      const brief = {
        problem: 'Handle special & chars! (safely)',
        proposedSolution: 'Solution',
        exampleInput: 'input',
        exampleOutput: 'output',
      };

      const saved = suggester.saveBrief(brief);
      expect(saved.filePath).toContain('handle-special-chars-safely');
    });

    it('should truncate long slugs', () => {
      const brief = {
        problem: 'This is a very long problem description that should be truncated in the filename for safety',
        proposedSolution: 'Solution',
        exampleInput: 'input',
        exampleOutput: 'output',
      };

      const saved = suggester.saveBrief(brief);
      const fileName = saved.filePath.split('/').pop() ?? '';
      // Filename should be reasonable length
      expect(fileName.length).toBeLessThan(120);
    });
  });
});
