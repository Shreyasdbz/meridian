// @meridian — Application entry point (Phase 8.1)
//
// Bootstraps the complete Meridian system:
// 1. Load config and init logging → liveness probe
// 2. Open databases, run migrations
// 3. Axis core startup
// 4. Register Scout, Sentinel, Journal (stub), built-in Gear
// 5. Crash recovery
// 6. Bridge startup → readiness probe
// 7. Begin processing queue
//
// Architecture references:
// - Section 4.5 (Request Lifecycle)
// - Section 4.6 (Conversation Threading)
// - Section 5.1.14 (Startup Sequence)
// - Section 5.1.15 (Graceful Shutdown)

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createAxis } from '@meridian/axis';
import type { Axis, JobProcessor } from '@meridian/axis';
import { createBridgeServer } from '@meridian/bridge';
import type { BridgeServer } from '@meridian/bridge';
import { createGearRuntime, loadBuiltinManifests } from '@meridian/gear';
import type { GearRuntime } from '@meridian/gear';
import { createScout } from '@meridian/scout';
import type { Scout } from '@meridian/scout';
import { createSentinel } from '@meridian/sentinel';
import type { Sentinel } from '@meridian/sentinel';
import {
  createLogger,
  DatabaseClient,
  detectDeploymentTier,
  generateId,
  getDefaultConfig,
  loadConfig,
  migrate,
} from '@meridian/shared';
import type {
  AxisMessage,
  ComponentId,
  ExecutionPlan,
  Job,
  LLMProvider,
  Logger,
  MeridianConfig,
  ValidationResult,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = 'data';

// ---------------------------------------------------------------------------
// Job processor — the complete request lifecycle (Section 4.5)
// ---------------------------------------------------------------------------

/**
 * Options for creating the pipeline job processor.
 */
export interface PipelineProcessorOptions {
  axis: Axis;
  logger: Logger;
  db: DatabaseClient;
  bridge?: BridgeServer;
}

/**
 * Create the job processor that orchestrates the full request lifecycle:
 * Ingestion → Scout (planning) → Sentinel (validation) → Approval →
 * Gear (execution) → Response → Reflection (stub).
 *
 * The processor is the callback passed to Axis's WorkerPool. When a job
 * is claimed from the queue, the processor drives it through the pipeline.
 */
export function createPipelineProcessor(options: PipelineProcessorOptions): JobProcessor {
  const { axis, logger, db } = options;
  const router = axis.internals.router;
  const jobQueue = axis.internals.jobQueue;

  return async (job: Job, signal: AbortSignal): Promise<void> => {
    const correlationId = job.id;
    const jobId = job.id;

    logger.info('Processing job', { jobId, conversationId: job.conversationId });

    try {
      // -----------------------------------------------------------------------
      // Step 1: Ingestion — Retrieve user message from the database
      // -----------------------------------------------------------------------
      const messageRows = await db.query<{ content: string; conversation_id: string }>(
        'meridian',
        `SELECT content, conversation_id FROM messages
         WHERE job_id = ? AND role = 'user'
         ORDER BY created_at DESC LIMIT 1`,
        [jobId],
      );

      const userMessage = messageRows[0]?.content;
      if (!userMessage) {
        // No user message found — fail the job.
        // Job is already in 'planning' status (claimed by worker pool).
        await jobQueue.transition(jobId, 'planning', 'failed', {
          error: { code: 'NO_MESSAGE', message: 'No user message found for job', retriable: false },
        });
        return;
      }

      // -----------------------------------------------------------------------
      // Step 2: Dispatch to Scout (job is already in 'planning' from worker pool claim)
      // -----------------------------------------------------------------------

      // Retrieve conversation history for context
      const historyRows = await db.query<{
        role: string;
        content: string;
        created_at: string;
      }>(
        'meridian',
        `SELECT role, content, created_at FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
        [job.conversationId ?? ''],
      );

      const conversationHistory = historyRows.map((row) => ({
        id: generateId(),
        conversationId: job.conversationId ?? '',
        role: row.role as 'user' | 'assistant' | 'system',
        content: row.content,
        modality: 'text' as const,
        createdAt: row.created_at,
      }));

      const planRequest: AxisMessage = {
        id: generateId(),
        correlationId,
        timestamp: new Date().toISOString(),
        from: 'bridge' as ComponentId,
        to: 'scout' as ComponentId,
        type: 'plan.request',
        jobId,
        payload: {
          userMessage,
          jobId,
          conversationId: job.conversationId,
          conversationHistory,
        },
      };

      if (signal.aborted) return;

      let planResponse: AxisMessage;
      try {
        planResponse = await router.dispatch(planRequest);
      } catch (error: unknown) {
        // Infrastructure failure — router itself threw (should be rare)
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Scout dispatch infrastructure failure', { jobId, error: message });
        await jobQueue.transition(jobId, 'planning', 'failed', {
          error: {
            code: 'SCOUT_UNREACHABLE',
            message: `Scout planning failed: ${message}`,
            retriable: true,
          },
        });
        return;
      }

      // -----------------------------------------------------------------------
      // Step 3: Path Selection — inspect Scout output shape
      // -----------------------------------------------------------------------

      // Handle error responses from the router's error middleware (e.g., LLM API failure,
      // Scout handler throwing). The error middleware wraps exceptions into error AxisMessages
      // with payload.code and payload.message.
      if (planResponse.type === 'error') {
        const errorPayload = planResponse.payload as {
          message?: string;
          type?: string;
          code?: string;
        } | undefined;

        // Classify the error: ERR_DISPATCH wrapping LLM errors indicates unreachability
        const isUnreachable = errorPayload?.code === 'ERR_DISPATCH';
        const errorCode = isUnreachable ? 'SCOUT_UNREACHABLE' : 'SCOUT_ERROR';
        const retriable = isUnreachable || errorPayload?.type !== 'budget_exceeded';

        await jobQueue.transition(jobId, 'planning', 'failed', {
          error: {
            code: errorCode,
            message: errorPayload?.message ?? 'Scout returned an error',
            retriable,
          },
        });
        return;
      }

      const planPayload = planResponse.payload;
      const pathType = planPayload?.['path'] as string | undefined;

      // Fast path — conversational response, skip Sentinel/Gear
      if (pathType === 'fast') {
        const textResponse = planPayload?.['text'] as string | undefined;

        // Store assistant message
        if (textResponse) {
          await db.run(
            'meridian',
            `INSERT INTO messages (id, conversation_id, role, content, job_id, modality, created_at)
             VALUES (?, ?, 'assistant', ?, ?, 'text', ?)`,
            [generateId(), job.conversationId ?? '', textResponse, jobId, new Date().toISOString()],
          );
        }

        // Broadcast response via WebSocket (if bridge available)
        if (options.bridge) {
          options.bridge.wsManager.broadcast({
            type: 'result',
            jobId,
            result: { text: textResponse },
          });
        }

        await jobQueue.transition(jobId, 'planning', 'completed', {
          result: { path: 'fast', text: textResponse },
        });

        logger.info('Job completed via fast path', { jobId });
        return;
      }

      // Full path — ExecutionPlan, proceed with validation
      const plan = planPayload?.['plan'] as ExecutionPlan | undefined;
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        await jobQueue.transition(jobId, 'planning', 'failed', {
          error: {
            code: 'INVALID_PLAN',
            message: 'Scout produced an invalid or empty execution plan',
            retriable: true,
          },
        });
        return;
      }

      // -----------------------------------------------------------------------
      // Step 4: Transition to validating and dispatch to Sentinel
      // -----------------------------------------------------------------------
      await jobQueue.transition(jobId, 'planning', 'validating', { plan });

      // Sentinel only sees the plan — information barrier enforced
      const validateRequest: AxisMessage = {
        id: generateId(),
        correlationId,
        timestamp: new Date().toISOString(),
        from: 'bridge' as ComponentId,
        to: 'sentinel' as ComponentId,
        type: 'validate.request',
        jobId,
        payload: { plan },
      };

      let validateResponse: AxisMessage;
      try {
        validateResponse = await router.dispatch(validateRequest);
      } catch (error: unknown) {
        // Sentinel unreachable — graceful degradation
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Sentinel dispatch failed', { jobId, error: message });
        await jobQueue.transition(jobId, 'validating', 'failed', {
          error: {
            code: 'SENTINEL_UNREACHABLE',
            message: `Sentinel validation failed: ${message}`,
            retriable: true,
          },
        });
        return;
      }

      const validationPayload = validateResponse.payload;
      if (!validationPayload || typeof validationPayload['verdict'] !== 'string') {
        await jobQueue.transition(jobId, 'validating', 'failed', {
          error: {
            code: 'INVALID_VALIDATION',
            message: 'Sentinel returned an invalid validation result',
            retriable: false,
          },
        });
        return;
      }

      const validation = validationPayload as unknown as ValidationResult;

      // -----------------------------------------------------------------------
      // Step 5: Route based on Sentinel verdict
      // -----------------------------------------------------------------------
      if (validation.verdict === 'rejected') {
        await jobQueue.transition(jobId, 'validating', 'failed', {
          validation,
          error: {
            code: 'PLAN_REJECTED',
            message: validation.reasoning ?? 'Plan rejected by Sentinel',
            retriable: false,
          },
        });
        return;
      }

      if (validation.verdict === 'needs_revision') {
        // In v0.1, we fail with revision needed rather than re-planning
        await jobQueue.transition(jobId, 'validating', 'failed', {
          validation,
          error: {
            code: 'NEEDS_REVISION',
            message: validation.suggestedRevisions ?? 'Plan needs revision',
            retriable: true,
          },
        });
        return;
      }

      if (validation.verdict === 'needs_user_approval') {
        // Route to awaiting_approval — Bridge broadcasts via WebSocket
        await jobQueue.transition(jobId, 'validating', 'awaiting_approval', { validation });
        // The job stays in awaiting_approval until user approves via Bridge API.
        // The approval handler in Bridge will transition to 'executing'.
        logger.info('Job awaiting user approval', { jobId });
        return;
      }

      // verdict === 'approved' — proceed directly to execution
      // -----------------------------------------------------------------------
      // Step 6: Execute plan steps via Gear
      // -----------------------------------------------------------------------
      await executePlan(
        jobId,
        correlationId,
        plan,
        validation,
        signal,
        router,
        jobQueue,
        db,
        logger,
        options.bridge,
        job.conversationId,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Job processing failed unexpectedly', { jobId, error: message });

      // Try to fail the job — may throw if transition is invalid
      try {
        const currentJob = await jobQueue.getJob(jobId);
        if (currentJob && !['completed', 'failed', 'cancelled'].includes(currentJob.status)) {
          await jobQueue.transition(jobId, currentJob.status, 'failed', {
            error: {
              code: 'UNEXPECTED_ERROR',
              message: `Unexpected error: ${message}`,
              retriable: true,
            },
          });
        }
      } catch {
        logger.error('Failed to transition job to failed state', { jobId });
      }
    }
  };
}

/**
 * Execute all steps in an approved plan via the Gear runtime.
 */
async function executePlan(
  jobId: string,
  correlationId: string,
  plan: ExecutionPlan,
  validation: ValidationResult,
  signal: AbortSignal,
  router: Axis['internals']['router'],
  jobQueue: Axis['internals']['jobQueue'],
  db: DatabaseClient,
  logger: Logger,
  bridge: BridgeServer | undefined,
  conversationId: string | undefined,
): Promise<void> {
  await jobQueue.transition(jobId, 'validating', 'executing', { validation });

  const stepResults: Array<{
    stepId: string;
    result?: unknown;
    error?: { code: string; message: string };
  }> = [];

  for (const step of plan.steps) {
    if (signal.aborted) {
      await jobQueue.transition(jobId, 'executing', 'cancelled');
      return;
    }

    const executeRequest: AxisMessage = {
      id: generateId(),
      correlationId,
      timestamp: new Date().toISOString(),
      from: 'bridge' as ComponentId,
      to: 'gear:runtime' as ComponentId,
      type: 'execute.request',
      jobId,
      payload: {
        gear: step.gear,
        action: step.action,
        parameters: step.parameters,
        stepId: step.id,
      },
    };

    try {
      const executeResponse = await router.dispatch(executeRequest);
      const responsePayload = executeResponse.payload;

      if (responsePayload?.['error']) {
        const gearError = responsePayload['error'] as { code: string; message: string };
        stepResults.push({ stepId: step.id, error: gearError });
        logger.warn('Gear execution step failed', {
          jobId,
          stepId: step.id,
          gear: step.gear,
          error: gearError.message,
        });
        // Continue to next step or fail job based on the error
        // For v0.1, fail the job on any step failure
        break;
      }

      stepResults.push({
        stepId: step.id,
        result: responsePayload?.['result'],
      });

      logger.info('Gear execution step completed', {
        jobId,
        stepId: step.id,
        gear: step.gear,
      });
    } catch (error: unknown) {
      // Gear sandbox failure — graceful degradation (Section 4.4)
      const message = error instanceof Error ? error.message : String(error);
      stepResults.push({
        stepId: step.id,
        error: { code: 'GEAR_EXECUTION_FAILED', message },
      });
      logger.error('Gear execution failed', { jobId, stepId: step.id, error: message });
      break;
    }
  }

  // Check if any step failed
  const failedStep = stepResults.find((s) => s.error);
  if (failedStep) {
    await jobQueue.transition(jobId, 'executing', 'failed', {
      result: { steps: stepResults },
      error: {
        code: failedStep.error?.code ?? 'GEAR_EXECUTION_FAILED',
        message: failedStep.error?.message ?? 'Gear execution failed',
        retriable: true,
      },
    });

    // Broadcast error via WebSocket
    if (bridge) {
      bridge.wsManager.broadcast({
        type: 'error',
        jobId,
        code: failedStep.error?.code ?? 'GEAR_EXECUTION_FAILED',
        message: failedStep.error?.message ?? 'Execution failed',
      });
    }
    return;
  }

  // All steps completed successfully
  const jobResult = { path: 'full' as const, steps: stepResults };

  // Store assistant response summarizing results
  const resultSummary = stepResults
    .map((s) => `Step ${s.stepId}: ${JSON.stringify(s.result)}`)
    .join('\n');

  await db.run(
    'meridian',
    `INSERT INTO messages (id, conversation_id, role, content, job_id, modality, created_at)
     VALUES (?, ?, 'assistant', ?, ?, 'text', ?)`,
    [generateId(), conversationId ?? '', resultSummary, jobId, new Date().toISOString()],
  );

  await jobQueue.transition(jobId, 'executing', 'completed', { result: jobResult });

  // Broadcast result via WebSocket
  if (bridge) {
    bridge.wsManager.broadcast({
      type: 'result',
      jobId,
      result: jobResult,
    });
  }

  logger.info('Job completed via full path', {
    jobId,
    stepCount: plan.steps.length,
    completedSteps: stepResults.length,
  });

  // Step 11: Reflection — stubbed for v0.1
  // Journal only stores conversation history (already done above via messages table)
}

// ---------------------------------------------------------------------------
// Application bootstrap
// ---------------------------------------------------------------------------

/**
 * Create and start the full Meridian application.
 *
 * This is the top-level orchestration function that wires all components
 * together and returns a handle for graceful shutdown.
 */
export async function startMeridian(options?: {
  dataDir?: string;
  configPath?: string;
  provider?: LLMProvider;
}): Promise<{
  axis: Axis;
  scout: Scout;
  sentinel: Sentinel;
  gearRuntime: GearRuntime;
  bridge: BridgeServer;
  shutdown: () => Promise<void>;
}> {
  const projectRoot = process.cwd();
  const dataDir = resolve(options?.dataDir ?? DEFAULT_DATA_DIR);

  // -------------------------------------------------------------------------
  // Step 1: Load config, init logging → liveness probe
  // -------------------------------------------------------------------------
  const tier = detectDeploymentTier();
  const configResult = loadConfig({ tier, configPath: options?.configPath });

  let config: MeridianConfig;
  if (configResult.ok) {
    config = configResult.value;
  } else {
    // Fall back to defaults if config file is missing or invalid
    config = getDefaultConfig(tier);
  }

  const logger = createLogger({ level: 'info' });
  logger.info('Starting Meridian', { tier, dataDir });

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Ensure workspace directory exists
  const workspacePath = resolve(dataDir, 'workspace');
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Step 2: Open databases, run migrations
  // -------------------------------------------------------------------------
  const db = new DatabaseClient({ dataDir, direct: true });
  await db.start();
  await db.open('meridian');
  await migrate(db, 'meridian', projectRoot);

  logger.info('Database initialized');

  // -------------------------------------------------------------------------
  // Step 3: Axis core startup (with pipeline processor wired later)
  // -------------------------------------------------------------------------

  // We need a reference to bridge for the processor, but bridge needs axis.
  // Use a deferred reference pattern — object wrapper allows const binding.
  const bridgeRef: { current?: BridgeServer } = {};

  const processor: JobProcessor = async (job, signal) => {
    const pipeline = createPipelineProcessor({
      axis,
      logger,
      db,
      bridge: bridgeRef.current,
    });
    return pipeline(job, signal);
  };

  const axis = createAxis({
    db,
    config,
    dataDir,
    projectRoot,
    processor,
    logger,
  });

  await axis.start();
  logger.info('Axis runtime started');

  // -------------------------------------------------------------------------
  // Step 4: Register Scout, Sentinel, Journal (stub), built-in Gear
  // -------------------------------------------------------------------------

  // Scout — requires an LLM provider
  let provider: LLMProvider;
  if (options?.provider) {
    provider = options.provider;
  } else {
    // Create provider from config
    const { createProvider } = await import('@meridian/scout');
    provider = createProvider({
      type: config.scout.provider as 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter',
      model: config.scout.models.primary,
    });
  }

  const builtinManifests = loadBuiltinManifests();

  const scout = createScout(
    {
      provider,
      primaryModel: config.scout.models.primary,
      secondaryModel: config.scout.models.secondary,
      temperature: config.scout.temperature,
      gearCatalog: builtinManifests,
      logger,
    },
    { registry: axis.internals.registry },
  );

  // Sentinel — rule-based in v0.1
  const sentinel = createSentinel(
    {
      policyConfig: {
        workspacePath,
        allowlistedDomains: [],
      },
      logger,
    },
    { registry: axis.internals.registry },
  );

  // Gear runtime — registers built-in Gear and message handler
  const gearPackagesDir = resolve(dataDir, 'gear-packages');
  if (!existsSync(gearPackagesDir)) {
    mkdirSync(gearPackagesDir, { recursive: true });
  }

  const gearRuntime = await createGearRuntime(
    {
      db,
      gearPackagesDir,
      workspacePath,
      builtinManifests,
      logger,
    },
    { registry: axis.internals.registry },
  );

  // Journal — stub for v0.1 (conversation history only, stored in messages table)
  logger.info('Journal stub initialized (v0.1 — conversation history only)');

  logger.info('Components registered', {
    scout: axis.internals.registry.has('scout'),
    sentinel: axis.internals.registry.has('sentinel'),
    gear: axis.internals.registry.has('gear:runtime'),
  });

  // -------------------------------------------------------------------------
  // Step 5: Crash recovery (handled by Axis lifecycle)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Step 6: Bridge startup → readiness probe
  // -------------------------------------------------------------------------
  const bridge = await createBridgeServer(config.bridge, axis, {
    db,
    logger,
    auditLog: axis.internals.auditLog,
    isReady: () => axis.isReady(),
  });

  await bridge.start();
  bridgeRef.current = bridge;

  logger.info('Meridian ready', {
    bind: config.bridge.bind,
    port: config.bridge.port,
    tier,
  });

  // -------------------------------------------------------------------------
  // Step 7: Graceful shutdown
  // -------------------------------------------------------------------------
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down Meridian...');

    // 1. Stop Bridge (stop accepting new connections)
    await bridge.stop();

    // 2. Stop Axis (stops worker pool — waits for active jobs to finish,
    //    then stops maintenance and watchdog). Must happen BEFORE disposing
    //    components so that in-flight jobs can still dispatch to Scout/Sentinel/Gear.
    await axis.stop();

    // 3. Dispose components (safe now — no active workers)
    scout.dispose();
    sentinel.dispose();
    gearRuntime.dispose();
    await gearRuntime.shutdown();

    // 4. Close database
    await db.close();

    logger.info('Meridian shutdown complete');
  };

  // Register signal handlers for graceful shutdown
  const handleSignal = (signal: string): void => {
    logger.info(`Received ${signal}`);
    void shutdown().then(() => {
      process.exit(0);
    }).catch((error: unknown) => {
      logger.error('Shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => { handleSignal('SIGTERM'); });
  process.on('SIGINT', () => { handleSignal('SIGINT'); });

  return { axis, scout, sentinel, gearRuntime, bridge, shutdown };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Only run when executed directly (not imported)
const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('/main.ts') || process.argv[1].endsWith('/main.js'));

if (isMainModule) {
  startMeridian().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start Meridian:', error);
    process.exit(1);
  });
}
