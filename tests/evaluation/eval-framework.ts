// Meridian — LLM Evaluation Framework (Phase 9.7)
//
// Provides a lightweight, deterministic evaluation runner for testing
// LLM-powered components (Scout planning, Sentinel validation) against
// curated test cases in both mock and live modes.
//
// Mock mode: uses deterministic executor functions for CI.
// Live mode: calls real LLM providers for periodic quality checks.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvalDifficulty = 'easy' | 'medium' | 'hard';
export type EvalMode = 'mock' | 'live';

export interface EvalCase {
  id: string;
  name: string;
  description: string;
  difficulty: EvalDifficulty;
  input: Record<string, unknown>;
  expectedOutput: Record<string, unknown>;
  validator: (output: Record<string, unknown>, expected: Record<string, unknown>) => boolean;
}

export interface EvalResult {
  caseId: string;
  passed: boolean;
  durationMs: number;
  output: Record<string, unknown>;
  error?: string;
}

export interface EvalSuiteResult {
  suiteName: string;
  totalCases: number;
  passed: number;
  failed: number;
  results: EvalResult[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class EvalRunner {
  private readonly mode: EvalMode;
  private readonly suiteName: string;

  constructor(suiteName: string, mode: EvalMode = 'mock') {
    this.mode = mode;
    this.suiteName = suiteName;
  }

  getMode(): EvalMode {
    return this.mode;
  }

  getSuiteName(): string {
    return this.suiteName;
  }

  async run(
    cases: EvalCase[],
    executor: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): Promise<EvalSuiteResult> {
    const startTime = Date.now();
    const results: EvalResult[] = [];

    for (const evalCase of cases) {
      const caseStart = Date.now();
      try {
        const output = await executor(evalCase.input);
        const passed = evalCase.validator(output, evalCase.expectedOutput);
        results.push({
          caseId: evalCase.id,
          passed,
          durationMs: Date.now() - caseStart,
          output,
        });
      } catch (error) {
        results.push({
          caseId: evalCase.id,
          passed: false,
          durationMs: Date.now() - caseStart,
          output: {},
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      suiteName: this.suiteName,
      totalCases: cases.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
      durationMs: Date.now() - startTime,
    };
  }
}
