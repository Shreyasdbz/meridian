// @meridian/axis — DAG Executor (Phase 9.9)
// Resolves step dependencies, runs steps in topological order with parallel
// execution within layers, handles $ref:step placeholder resolution, and
// integrates with conditions and circuit breakers.

import type { ExecutionStep, StepCondition } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of executing a single step. */
export interface StepResult {
  stepId: string;
  status: 'completed' | 'failed' | 'skipped';
  result?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

/** Aggregate result of executing a DAG of steps. */
export interface DagExecutionResult {
  status: 'completed' | 'partial' | 'failed';
  stepResults: StepResult[];
  durationMs: number;
}

/**
 * Function that executes a single step. Provided by the caller so the
 * DAG executor is decoupled from Gear dispatch.
 */
export type StepExecutor = (
  step: ExecutionStep,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

/** Configuration for the DagExecutor. */
export interface DagExecutorConfig {
  /** Max concurrent steps per layer. Default: 4. */
  maxConcurrency?: number;
  /** Optional condition evaluator. */
  evaluateCondition?: (
    condition: StepCondition,
    results: Map<string, StepResult>,
  ) => boolean;
  /** Optional circuit breaker check. */
  isCircuitOpen?: (gearId: string) => boolean;
  /** Optional logger. */
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENCY = 4;

/** Pattern for $ref:step references in parameters. */
const STEP_REF_PATTERN = /^\$ref:step:([a-zA-Z0-9_-]+)(?:\.(.+))?$/;

// ---------------------------------------------------------------------------
// DagExecutor
// ---------------------------------------------------------------------------

/**
 * Executes an array of ExecutionSteps respecting dependency ordering,
 * parallel groups, conditions, and circuit breakers.
 *
 * Uses Kahn's algorithm for topological sort into parallelizable layers.
 * Steps within the same layer run concurrently up to `maxConcurrency`.
 * Failed steps cause all transitive dependents to be skipped.
 */
export class DagExecutor {
  private readonly maxConcurrency: number;
  private readonly evaluateCondition?: DagExecutorConfig['evaluateCondition'];
  private readonly isCircuitOpen?: DagExecutorConfig['isCircuitOpen'];
  private readonly logger?: DagExecutorConfig['logger'];

  constructor(config?: DagExecutorConfig) {
    this.maxConcurrency = config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.evaluateCondition = config?.evaluateCondition;
    this.isCircuitOpen = config?.isCircuitOpen;
    this.logger = config?.logger;
  }

  /**
   * Execute steps in dependency order.
   *
   * Uses Kahn's algorithm for topological sort into parallelizable layers.
   * Steps in the same parallelGroup run together.
   * Failed steps cause dependent steps to be skipped.
   * `$ref:step:<stepId>` placeholders in parameters are resolved from
   * prior step results.
   */
  async execute(
    steps: ExecutionStep[],
    executor: StepExecutor,
    signal?: AbortSignal,
  ): Promise<DagExecutionResult> {
    const overallStart = Date.now();

    // Handle empty steps
    if (steps.length === 0) {
      return { status: 'completed', stepResults: [], durationMs: 0 };
    }

    // Validate for self-dependencies
    for (const step of steps) {
      if (step.dependsOn?.includes(step.id)) {
        throw new Error(`Step '${step.id}' has a self-dependency`);
      }
    }

    // Build layers via topological sort (Kahn's algorithm)
    const layers = this.topologicalSort(steps);

    const results = new Map<string, StepResult>();
    const skippedSteps = new Set<string>();

    // Build a map of step ID -> dependent step IDs for failure propagation
    const dependentsMap = this.buildDependentsMap(steps);

    for (const layer of layers) {
      // Check for abort before each layer
      if (signal?.aborted) {
        // Skip all remaining steps
        for (const step of layer) {
          if (!results.has(step.id)) {
            results.set(step.id, {
              stepId: step.id,
              status: 'skipped',
              error: 'Execution cancelled',
              durationMs: 0,
            });
          }
        }
        continue;
      }

      // Execute steps in the layer with concurrency limiting
      await this.executeLayer(
        layer,
        executor,
        results,
        skippedSteps,
        dependentsMap,
        signal,
      );
    }

    const stepResults = this.orderResults(steps, results);
    const durationMs = Date.now() - overallStart;

    return {
      status: this.computeOverallStatus(stepResults),
      stepResults,
      durationMs,
    };
  }

  // -------------------------------------------------------------------------
  // Topological sort (Kahn's algorithm)
  // -------------------------------------------------------------------------

  /**
   * Sort steps into layers using Kahn's algorithm.
   * Each layer contains steps whose dependencies are all in prior layers.
   * Throws if a cycle is detected.
   */
  private topologicalSort(steps: ExecutionStep[]): ExecutionStep[][] {
    const stepMap = new Map<string, ExecutionStep>();
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>(); // step -> dependents

    // Initialize
    for (const step of steps) {
      stepMap.set(step.id, step);
      inDegree.set(step.id, 0);
      adjacency.set(step.id, []);
    }

    // Build adjacency list and compute in-degrees
    for (const step of steps) {
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!stepMap.has(depId)) {
            throw new Error(
              `Step '${step.id}' depends on unknown step '${depId}'`,
            );
          }
          // depId -> step.id (depId must complete before step.id)
          const depAdj = adjacency.get(depId);
          if (depAdj) {
            depAdj.push(step.id);
          }
          inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
        }
      }
    }

    // Kahn's algorithm: process layer by layer
    const layers: ExecutionStep[][] = [];
    let queue = steps
      .filter((s) => inDegree.get(s.id) === 0)
      .map((s) => s.id);

    let processedCount = 0;

    while (queue.length > 0) {
      // Current layer = all zero-degree nodes
      const layer: ExecutionStep[] = queue
        .map((id) => stepMap.get(id))
        .filter((step): step is ExecutionStep => step !== undefined);
      layers.push(layer);
      processedCount += layer.length;

      const nextQueue: string[] = [];

      for (const stepId of queue) {
        for (const dependentId of adjacency.get(stepId) ?? []) {
          const newDegree = (inDegree.get(dependentId) ?? 1) - 1;
          inDegree.set(dependentId, newDegree);
          if (newDegree === 0) {
            nextQueue.push(dependentId);
          }
        }
      }

      queue = nextQueue;
    }

    // If we didn't process all steps, there's a cycle
    if (processedCount < steps.length) {
      const remaining = steps
        .filter((s) => {
          const degree = inDegree.get(s.id);
          return degree !== undefined && degree > 0;
        })
        .map((s) => s.id);
      throw new Error(
        `Cycle detected in step dependencies: ${remaining.join(', ')}`,
      );
    }

    return layers;
  }

  // -------------------------------------------------------------------------
  // Layer execution
  // -------------------------------------------------------------------------

  /**
   * Execute all steps in a layer with concurrency limiting.
   */
  private async executeLayer(
    layer: ExecutionStep[],
    executor: StepExecutor,
    results: Map<string, StepResult>,
    skippedSteps: Set<string>,
    dependentsMap: Map<string, Set<string>>,
    signal?: AbortSignal,
  ): Promise<void> {
    // Process in chunks of maxConcurrency
    for (let i = 0; i < layer.length; i += this.maxConcurrency) {
      const chunk = layer.slice(i, i + this.maxConcurrency);

      const settled = await Promise.allSettled(
        chunk.map((step) =>
          this.executeStep(step, executor, results, skippedSteps, signal),
        ),
      );

      // Process results and propagate failures
      for (let j = 0; j < settled.length; j++) {
        const step = chunk[j];
        const outcome = settled[j];
        if (!step || !outcome) {
          continue;
        }

        if (outcome.status === 'rejected') {
          // Executor threw unexpectedly — treat as step failure
          const result: StepResult = {
            stepId: step.id,
            status: 'failed',
            error: outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
            durationMs: 0,
          };
          results.set(step.id, result);
        }

        // Propagate skips if the step failed
        const stepResult = results.get(step.id);
        if (stepResult && stepResult.status === 'failed') {
          this.propagateSkips(step.id, dependentsMap, skippedSteps);
        }
      }
    }
  }

  /**
   * Execute a single step, handling conditions, circuit breakers,
   * skip propagation, and $ref resolution.
   */
  private async executeStep(
    step: ExecutionStep,
    executor: StepExecutor,
    results: Map<string, StepResult>,
    skippedSteps: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    // Already skipped due to a failed dependency
    if (skippedSteps.has(step.id)) {
      results.set(step.id, {
        stepId: step.id,
        status: 'skipped',
        error: 'Skipped due to failed dependency',
        durationMs: 0,
      });
      this.logger?.warn(`Step '${step.id}' skipped due to failed dependency`);
      return;
    }

    // Circuit breaker check
    if (this.isCircuitOpen && this.isCircuitOpen(step.gear)) {
      results.set(step.id, {
        stepId: step.id,
        status: 'skipped',
        error: `Circuit breaker open for gear: ${step.gear}`,
        durationMs: 0,
      });
      this.logger?.warn(
        `Step '${step.id}' skipped: circuit breaker open for gear '${step.gear}'`,
      );
      return;
    }

    // Condition evaluation
    if (step.condition && this.evaluateCondition) {
      const conditionMet = this.evaluateCondition(step.condition, results);
      if (!conditionMet) {
        results.set(step.id, {
          stepId: step.id,
          status: 'skipped',
          error: 'Condition evaluated to false',
          durationMs: 0,
        });
        this.logger?.info(
          `Step '${step.id}' skipped: condition not met`,
        );
        return;
      }
    }

    // Resolve $ref:step placeholders in parameters
    const resolvedStep = this.resolveRefs(step, results);

    // Execute
    const start = Date.now();
    try {
      this.logger?.info(`Executing step '${step.id}'`);
      const result = await executor(resolvedStep, signal);
      const durationMs = Date.now() - start;

      results.set(step.id, {
        stepId: step.id,
        status: 'completed',
        result,
        durationMs,
      });
      this.logger?.info(
        `Step '${step.id}' completed in ${durationMs}ms`,
      );
    } catch (error: unknown) {
      const durationMs = Date.now() - start;
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

      results.set(step.id, {
        stepId: step.id,
        status: 'failed',
        error: errorMessage,
        durationMs,
      });
      this.logger?.error(
        `Step '${step.id}' failed: ${errorMessage}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // $ref:step resolution
  // -------------------------------------------------------------------------

  /**
   * Deep-clone the step and resolve all `$ref:step:<stepId>` and
   * `$ref:step:<stepId>.path.to.field` references in `parameters`.
   */
  private resolveRefs(
    step: ExecutionStep,
    results: Map<string, StepResult>,
  ): ExecutionStep {
    const resolvedParams = this.resolveRefsInValue(
      step.parameters,
      results,
    ) as Record<string, unknown>;

    return { ...step, parameters: resolvedParams };
  }

  /**
   * Recursively walk a value and resolve any string $ref:step references.
   */
  private resolveRefsInValue(
    value: unknown,
    results: Map<string, StepResult>,
  ): unknown {
    if (typeof value === 'string') {
      return this.resolveStringRef(value, results);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveRefsInValue(item, results));
    }

    if (value !== null && typeof value === 'object') {
      const resolved: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        resolved[key] = this.resolveRefsInValue(val, results);
      }
      return resolved;
    }

    return value;
  }

  /**
   * Resolve a single string value if it matches the $ref:step pattern.
   * Returns the original string if no match.
   */
  private resolveStringRef(
    value: string,
    results: Map<string, StepResult>,
  ): unknown {
    const match = STEP_REF_PATTERN.exec(value);
    if (!match) {
      return value;
    }

    const [, stepId, dotPath] = match;
    if (!stepId) {
      this.logger?.warn(`$ref:step pattern matched but no stepId extracted from: ${value}`);
      return value;
    }
    const stepResult = results.get(stepId);

    if (!stepResult || !stepResult.result) {
      this.logger?.warn(
        `$ref:step:${stepId} could not be resolved — step has no result`,
      );
      return value;
    }

    if (!dotPath) {
      return stepResult.result;
    }

    return this.navigatePath(stepResult.result, dotPath);
  }

  /**
   * Navigate a dot-separated path into an object.
   * Returns `undefined` if any segment is missing.
   */
  private navigatePath(obj: Record<string, unknown>, path: string): unknown {
    const segments = path.split('.');
    let current: unknown = obj;

    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return current;
  }

  // -------------------------------------------------------------------------
  // Failure propagation
  // -------------------------------------------------------------------------

  /**
   * Build a map from each step ID to the set of step IDs that directly
   * depend on it.
   */
  private buildDependentsMap(
    steps: ExecutionStep[],
  ): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();

    for (const step of steps) {
      if (!map.has(step.id)) {
        map.set(step.id, new Set());
      }
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!map.has(depId)) {
            map.set(depId, new Set());
          }
          const depSet = map.get(depId);
          if (depSet) {
            depSet.add(step.id);
          }
        }
      }
    }

    return map;
  }

  /**
   * Transitively mark all dependents of a failed step as skipped.
   */
  private propagateSkips(
    failedStepId: string,
    dependentsMap: Map<string, Set<string>>,
    skippedSteps: Set<string>,
  ): void {
    const queue = [failedStepId];

    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      const dependents = dependentsMap.get(current);
      if (!dependents) {
        continue;
      }

      for (const depId of dependents) {
        if (!skippedSteps.has(depId)) {
          skippedSteps.add(depId);
          queue.push(depId);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Result helpers
  // -------------------------------------------------------------------------

  /**
   * Order results to match the original step order.
   */
  private orderResults(
    steps: ExecutionStep[],
    results: Map<string, StepResult>,
  ): StepResult[] {
    return steps
      .map((s) => results.get(s.id))
      .filter((r): r is StepResult => r !== undefined);
  }

  /**
   * Compute the overall execution status from individual step results.
   */
  private computeOverallStatus(
    stepResults: StepResult[],
  ): DagExecutionResult['status'] {
    const hasFailure = stepResults.some((r) => r.status === 'failed');
    const hasCompleted = stepResults.some((r) => r.status === 'completed');
    const allFailed = stepResults.every(
      (r) => r.status === 'failed' || r.status === 'skipped',
    );

    if (!hasFailure) {
      return 'completed';
    }

    if (allFailed) {
      return 'failed';
    }

    if (hasCompleted) {
      return 'partial';
    }

    return 'failed';
  }
}
