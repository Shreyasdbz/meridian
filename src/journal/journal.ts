// @meridian/journal — Journal component class (Phase 11.1)
//
// Wires the Reflector, MemoryWriter, and GearSuggester to the Axis message
// router so that reflect.request messages are handled end-to-end:
//   task execution → reflection → memory write → Gear brief generation
//
// Architecture references:
// - Section 5.1.14 (Startup Sequence — Component Registration)
// - Section 5.4 (Journal — Memory & Learning)
// - Section 5.4.4 (Gear Suggester — activated in v0.4)
// - Phase 11.1 (Gear Suggester Activation)

import type {
  AxisMessage,
  ComponentId,
  ComponentRegistry,
  ExecutionPlan,
  JobStatus,
} from '@meridian/shared';
import { generateId, ValidationError } from '@meridian/shared';

import type { GearSuggester, SavedGearBrief } from './gear-suggester.js';
import type { MemoryWriter, WriteResult } from './memory-writer.js';
import type { Reflector, ReflectionInput, ReflectionResult } from './reflector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JournalConfig {
  /** Reflector for LLM-based post-task analysis. */
  reflector: Reflector;
  /** MemoryWriter for persisting reflection results. */
  memoryWriter: MemoryWriter;
  /** GearSuggester for saving Gear briefs from reflections. */
  gearSuggester: GearSuggester;
  /** Logger for Journal events. */
  logger?: JournalLogger;
}

export interface JournalLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface JournalDependencies {
  /** Component registry for message handler registration. */
  registry: ComponentRegistry;
}

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: JournalLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Journal component
// ---------------------------------------------------------------------------

/**
 * Journal — the memory and learning component of Meridian.
 *
 * Registers with Axis as a message handler for `reflect.request` messages.
 * Orchestrates the post-task analysis pipeline:
 *   1. Run Reflector (LLM-based reflection)
 *   2. Write results to memory via MemoryWriter
 *   3. Process Gear suggestions via GearSuggester
 *   4. Return results including any Gear brief
 *
 * Lifecycle:
 * 1. Create with `createJournal(config, deps)`
 * 2. Journal auto-registers with Axis's component registry
 * 3. Axis dispatches `reflect.request` messages to Journal's handler
 * 4. Call `dispose()` during shutdown to unregister
 */
export class Journal {
  private readonly reflector: Reflector;
  private readonly memoryWriter: MemoryWriter;
  private readonly gearSuggester: GearSuggester;
  private readonly registry: ComponentRegistry;
  private readonly logger: JournalLogger;
  private disposed = false;

  constructor(config: JournalConfig, deps: JournalDependencies) {
    this.reflector = config.reflector;
    this.memoryWriter = config.memoryWriter;
    this.gearSuggester = config.gearSuggester;
    this.registry = deps.registry;
    this.logger = config.logger ?? noopLogger;

    // Register with Axis's component registry
    this.registry.register('journal', this.handleMessage.bind(this));

    this.logger.info('Journal registered with Axis');
  }

  /**
   * Handle an incoming AxisMessage.
   *
   * Expects `reflect.request` messages with the following payload fields:
   * - `plan` (ExecutionPlan, required) — the plan that was executed
   * - `status` (JobStatus, required) — final job status
   * - `userMessage` (string, optional) — original user message
   * - `assistantResponse` (string, optional) — assistant's response
   * - `stepResults` (array, optional) — per-step execution results
   */
  private async handleMessage(
    message: AxisMessage,
    _signal: AbortSignal,
  ): Promise<AxisMessage> {
    if (message.type !== 'reflect.request') {
      throw new ValidationError(
        `Journal received unexpected message type: '${message.type}'. Expected 'reflect.request'.`,
      );
    }

    const payload = message.payload ?? {};
    const jobId = message.jobId ?? (payload['jobId'] as string | undefined) ?? '';

    if (!payload['plan'] || typeof payload['plan'] !== 'object') {
      throw new ValidationError(
        'reflect.request payload must contain an "plan" field',
      );
    }

    if (!payload['status'] || typeof payload['status'] !== 'string') {
      throw new ValidationError(
        'reflect.request payload must contain a string "status" field',
      );
    }

    this.logger.debug('Received reflect.request', {
      messageId: message.id,
      correlationId: message.correlationId,
      jobId,
      from: message.from,
    });

    // Build reflection input from payload
    const reflectionInput: ReflectionInput = {
      plan: payload['plan'] as ExecutionPlan,
      status: payload['status'] as JobStatus,
      userMessage: (payload['userMessage'] as string | undefined) ?? '',
      assistantResponse: (payload['assistantResponse'] as string | undefined) ?? '',
      stepResults: payload['stepResults'] as ReflectionInput['stepResults'],
    };

    // Step 1: Run Reflector (LLM-based analysis)
    let reflection: ReflectionResult;
    try {
      reflection = await this.reflector.reflect(reflectionInput);
    } catch (error) {
      this.logger.error('Reflection failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.buildErrorResponse(message, 'REFLECTION_FAILED', error);
    }

    // Step 2: Write results to memory
    let writeResult: WriteResult | undefined;
    try {
      writeResult = await this.memoryWriter.write(reflection, jobId);
      this.logger.info('Memory write complete', {
        jobId,
        episodeId: writeResult.episodeId,
        stagedFacts: writeResult.stagedFacts,
        stagedProcedures: writeResult.stagedProcedures,
      });
    } catch (error) {
      // Memory write failure is non-blocking — log and continue
      this.logger.warn('Memory write failed (non-blocking)', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 3: Process Gear suggestion (if reflection produced one)
    let savedBrief: SavedGearBrief | null = null;
    try {
      savedBrief = this.gearSuggester.processSuggestion(reflection);
      if (savedBrief) {
        this.logger.info('Gear brief saved from reflection', {
          jobId,
          briefPath: savedBrief.filePath,
          problem: savedBrief.brief.problem.slice(0, 80),
        });
      }
    } catch (error) {
      // Gear suggestion failure is non-blocking — log and continue
      this.logger.warn('Gear suggestion processing failed (non-blocking)', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 4: Build and return response
    return this.buildResponse(message, reflection, writeResult, savedBrief);
  }

  /**
   * Build a successful reflect.response AxisMessage.
   */
  private buildResponse(
    request: AxisMessage,
    reflection: ReflectionResult,
    writeResult: WriteResult | undefined,
    savedBrief: SavedGearBrief | null,
  ): AxisMessage {
    const responsePayload: Record<string, unknown> = {
      reflection: {
        episode: reflection.episode,
        factsCount: reflection.facts.length,
        proceduresCount: reflection.procedures.length,
        contradictionsCount: reflection.contradictions.length,
      },
    };

    if (writeResult) {
      responsePayload['memory'] = {
        episodeId: writeResult.episodeId,
        stagedFacts: writeResult.stagedFacts,
        stagedProcedures: writeResult.stagedProcedures,
        contradictionsFound: writeResult.contradictionsFound,
        embeddingCreated: writeResult.embeddingCreated,
      };
    }

    if (savedBrief) {
      responsePayload['gearSuggestion'] = savedBrief.brief;
      responsePayload['briefId'] = savedBrief.filePath;
    }

    return {
      id: generateId(),
      correlationId: request.correlationId,
      timestamp: new Date().toISOString(),
      from: 'journal' as ComponentId,
      to: request.from,
      type: 'reflect.response',
      payload: responsePayload,
      replyTo: request.id,
      jobId: request.jobId,
    };
  }

  /**
   * Build an error response AxisMessage.
   */
  private buildErrorResponse(
    request: AxisMessage,
    code: string,
    error: unknown,
  ): AxisMessage {
    return {
      id: generateId(),
      correlationId: request.correlationId,
      timestamp: new Date().toISOString(),
      from: 'journal' as ComponentId,
      to: request.from,
      type: 'error',
      payload: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
      replyTo: request.id,
      jobId: request.jobId,
    };
  }

  /**
   * Unregister Journal from Axis.
   * Call during shutdown to clean up.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.registry.unregister('journal');
    this.disposed = true;

    this.logger.info('Journal unregistered from Axis');
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a Journal component and register it with Axis.
 *
 * @example
 * ```ts
 * const journal = createJournal(
 *   {
 *     reflector: new Reflector({ provider, model }),
 *     memoryWriter: new MemoryWriter({ memoryStore }),
 *     gearSuggester: new GearSuggester({ workspaceDir }),
 *   },
 *   { registry: axis.internals.registry },
 * );
 *
 * // Journal is now handling reflect.request messages via Axis
 *
 * // During shutdown:
 * journal.dispose();
 * ```
 */
export function createJournal(
  config: JournalConfig,
  deps: JournalDependencies,
): Journal {
  return new Journal(config, deps);
}
