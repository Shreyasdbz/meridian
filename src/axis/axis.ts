// @meridian/axis — Axis runtime class (Phase 2.8)
//
// Composes all Axis sub-systems into a single runtime:
// ComponentRegistry, MessageRouter, JobQueue, WorkerPool,
// PlanValidator, crash recovery, Watchdog, AuditLog,
// LifecycleManager, and BasicMaintenance.
//
// The Axis class is the single orchestration point for the
// deterministic runtime. It has NO LLM dependency.

import type {
  AxisConfig,
  DatabaseClient,
  Job,
  MeridianConfig,
} from '@meridian/shared';
import { migrateAll } from '@meridian/shared';

import { AuditLog } from './audit.js';
import { JobQueue } from './job-queue.js';
import { LifecycleManager } from './lifecycle.js';
import type { LifecycleLogger, StartupPhase } from './lifecycle.js';
import { BasicMaintenance } from './maintenance-basic.js';
import type { GearLookup } from './plan-validator.js';
import { validatePlan } from './plan-validator.js';
import { recoverJobs } from './recovery.js';
import type { RecoveryResult } from './recovery.js';
import { ComponentRegistryImpl } from './registry.js';
import { MessageRouter } from './router.js';
import { Watchdog } from './watchdog.js';
import { WorkerPool } from './worker-pool.js';
import type { JobProcessor } from './worker-pool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for Axis runtime events.
 */
export interface AxisLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Options for creating the Axis runtime.
 */
export interface AxisOptions {
  /** Database client (must be started before passing). */
  db: DatabaseClient;
  /** Full Meridian configuration. */
  config: MeridianConfig;
  /** Data directory for databases and workspace. */
  dataDir: string;
  /** Project root for migration discovery. */
  projectRoot: string;
  /** Job processor callback invoked by the worker pool for each claimed job. */
  processor: JobProcessor;
  /** Optional Gear registry for plan pre-validation. */
  gearLookup?: GearLookup;
  /** Optional logger. */
  logger?: AxisLogger;
  /** Bridge port (for lifecycle diagnostics). Default: config.bridge.port. */
  port?: number;
}

/**
 * Subset of Axis internals exposed for advanced use cases
 * (e.g., component registration, message dispatch).
 */
export interface AxisInternals {
  readonly registry: ComponentRegistryImpl;
  readonly router: MessageRouter;
  readonly jobQueue: JobQueue;
  readonly workerPool: WorkerPool;
  readonly watchdog: Watchdog;
  readonly auditLog: AuditLog;
  readonly lifecycle: LifecycleManager;
  readonly maintenance: BasicMaintenance;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: AxisLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Axis
// ---------------------------------------------------------------------------

/**
 * Axis — the deterministic runtime for Meridian.
 *
 * Composes the router, job queue, worker pool, plan validator,
 * crash recovery, watchdog, audit log, lifecycle manager, and
 * periodic maintenance into a single coordinated runtime.
 *
 * **No LLM dependency.** The job processor callback (provided
 * externally) is responsible for invoking Scout, Sentinel, and
 * Gear — Axis only manages scheduling, routing, and lifecycle.
 *
 * Usage:
 * ```ts
 * const axis = createAxis({ db, config, dataDir, projectRoot, processor });
 * await axis.start();
 * // ... Axis is now running, processing jobs via the worker pool ...
 * await axis.stop();
 * ```
 */
export class Axis {
  private readonly db: DatabaseClient;
  private readonly axisConfig: AxisConfig;
  private readonly dataDir: string;
  private readonly projectRoot: string;
  private readonly logger: AxisLogger;

  // Sub-systems
  private readonly _registry: ComponentRegistryImpl;
  private readonly _router: MessageRouter;
  private readonly _jobQueue: JobQueue;
  private readonly _workerPool: WorkerPool;
  private readonly _watchdog: Watchdog;
  private readonly _auditLog: AuditLog;
  private readonly _lifecycle: LifecycleManager;
  private readonly _maintenance: BasicMaintenance;

  private started = false;
  private lastRecoveryResult: RecoveryResult | undefined;

  constructor(options: AxisOptions) {
    this.db = options.db;
    this.axisConfig = options.config.axis;
    this.dataDir = options.dataDir;
    this.projectRoot = options.projectRoot;
    this.logger = options.logger ?? noopLogger;

    const port = options.port ?? options.config.bridge.port;

    // --- Initialize sub-systems ---

    // 1. Component registry
    this._registry = new ComponentRegistryImpl();

    // 2. Audit log
    this._auditLog = new AuditLog({
      db: this.db,
      dataDir: this.dataDir,
      logger: this.logger,
    });

    // 3. Message router (wired to registry + audit)
    this._router = new MessageRouter({
      registry: this._registry,
      auditWriter: {
        write: (entry) => {
          // Fire-and-forget audit write through the real AuditLog.
          // The router's AuditWriter interface is synchronous, but
          // the real AuditLog is async. We bridge the gap here.
          void this._auditLog.write({
            actor: entry.actor,
            action: entry.action,
            riskLevel: entry.riskLevel,
            actorId: entry.actorId,
            target: entry.target,
            jobId: entry.jobId,
            details: entry.details,
          }).catch((error: unknown) => {
            this.logger.error('Failed to write audit entry', {
              action: entry.action,
              actor: entry.actor,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
      },
      logger: this.logger,
    });

    // 4. Job queue
    this._jobQueue = new JobQueue(this.db);

    // 5. Worker pool
    this._workerPool = new WorkerPool({
      maxWorkers: this.axisConfig.workers,
      queue: this._jobQueue,
      processor: options.processor,
      logger: this.logger,
    });

    // 6. Watchdog
    this._watchdog = new Watchdog({
      logger: this.logger,
    });

    // 7. Lifecycle manager
    this._lifecycle = new LifecycleManager({
      dataDir: this.dataDir,
      port,
      logger: this.logger as LifecycleLogger,
    });

    // 8. Basic maintenance
    this._maintenance = new BasicMaintenance({
      db: this.db,
      logger: this.logger,
    });

    // --- Wire lifecycle steps ---
    this.registerLifecycleSteps();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the Axis runtime. Runs the full startup sequence:
   * config → database → axis_core → components → recovery → bridge → ready.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Axis is already started');
    }

    await this._lifecycle.startup();
    this.started = true;
  }

  /**
   * Stop the Axis runtime gracefully.
   * Stops the worker pool, watchdog, maintenance, and lifecycle manager.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this._lifecycle.shutdown();
    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a new job in the pending state.
   */
  async createJob(options: {
    conversationId?: string;
    parentId?: string;
    priority?: 'low' | 'normal' | 'high' | 'critical';
    source: 'user' | 'schedule' | 'webhook' | 'sub-job';
    sourceMessageId?: string;
    dedupHash?: string;
    maxAttempts?: number;
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Job> {
    return this._jobQueue.createJob(options);
  }

  /**
   * Get a job by ID.
   */
  async getJob(jobId: string): Promise<Job | undefined> {
    return this._jobQueue.getJob(jobId);
  }

  /**
   * Cancel a job.
   */
  async cancelJob(jobId: string): Promise<boolean> {
    return this._jobQueue.cancelJob(jobId);
  }

  /**
   * Pre-validate an execution plan (deterministic, no LLM).
   */
  validatePlan(
    ...args: Parameters<typeof validatePlan>
  ): ReturnType<typeof validatePlan> {
    return validatePlan(...args);
  }

  /**
   * Check if the Axis runtime is started and ready.
   */
  isReady(): boolean {
    return this.started && this._lifecycle.getReadiness();
  }

  /**
   * Check if the Axis runtime is live (responsive).
   */
  isLive(): boolean {
    return this._lifecycle.getLiveness();
  }

  /**
   * Get the current startup phase.
   */
  getPhase(): StartupPhase {
    return this._lifecycle.getPhase();
  }

  /**
   * Get the last crash recovery result.
   */
  getLastRecoveryResult(): RecoveryResult | undefined {
    return this.lastRecoveryResult;
  }

  /**
   * Access internal sub-systems for advanced use cases.
   */
  get internals(): AxisInternals {
    return {
      registry: this._registry,
      router: this._router,
      jobQueue: this._jobQueue,
      workerPool: this._workerPool,
      watchdog: this._watchdog,
      auditLog: this._auditLog,
      lifecycle: this._lifecycle,
      maintenance: this._maintenance,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle step registration
  // -------------------------------------------------------------------------

  private registerLifecycleSteps(): void {
    // Step 1: Config (already loaded — just mark as live)
    this._lifecycle.registerStep('config', 'Validate configuration', () => {
      this.logger.info('Configuration validated', {
        workers: this.axisConfig.workers,
        jobTimeoutMs: this.axisConfig.jobTimeoutMs,
      });
      return Promise.resolve();
    });

    // Step 2: Database migrations
    this._lifecycle.registerStep('database', 'Run database migrations', async () => {
      const results = await migrateAll(this.db, this.projectRoot, {
        databases: ['meridian'],
      });
      for (const result of results) {
        if (result.applied.length > 0) {
          this.logger.info('Applied migrations', {
            database: result.database,
            applied: result.applied,
            currentVersion: result.currentVersion,
          });
        }
      }
    });

    // Step 3: Axis core (watchdog + diagnostics)
    this._lifecycle.registerStep('axis_core', 'Start Axis core', async () => {
      // Run self-diagnostics
      const diagnostics = await this._lifecycle.runDiagnostics();
      for (const check of diagnostics.checks) {
        if (!check.passed) {
          if (check.severity === 'abort') {
            this.logger.error(`Diagnostic: ${check.name} — ${check.message}`, {
              severity: check.severity,
            });
          } else {
            this.logger.warn(`Diagnostic: ${check.name} — ${check.message}`, {
              severity: check.severity,
            });
          }
        }
      }
      if (!diagnostics.canProceed) {
        throw new Error('Startup aborted: critical diagnostic checks failed');
      }

      // Start watchdog
      this._watchdog.start();
    });

    // Step 4: Component registration (placeholder — components register themselves)
    this._lifecycle.registerStep('components', 'Register components', () => {
      this.logger.info('Component registration phase (components register externally)');
      return Promise.resolve();
    });

    // Step 5: Crash recovery
    this._lifecycle.registerStep('recovery', 'Run crash recovery', async () => {
      this.lastRecoveryResult = await recoverJobs(this.db, this.logger);
    });

    // Step 6: Bridge (placeholder — Bridge starts externally)
    this._lifecycle.registerStep('bridge', 'Start Bridge', async () => {
      // Start maintenance scheduler
      await this._maintenance.start();

      // Start worker pool
      this._workerPool.start();

      this.logger.info('Worker pool and maintenance started');
    });

    // --- Shutdown handlers (reverse order) ---
    this._lifecycle.registerShutdownHandler('Stop worker pool', async () => {
      await this._workerPool.stop();
    });

    this._lifecycle.registerShutdownHandler('Stop maintenance', () => {
      this._maintenance.stop();
      return Promise.resolve();
    });

    this._lifecycle.registerShutdownHandler('Stop watchdog', () => {
      this._watchdog.stop();
      return Promise.resolve();
    });
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an Axis runtime instance.
 *
 * This is the recommended way to instantiate Axis. It takes options
 * that configure all sub-systems and returns a ready-to-start Axis instance.
 *
 * @example
 * ```ts
 * const db = new DatabaseClient({ dataDir: './data', direct: true });
 * await db.start();
 *
 * const configResult = loadConfig();
 * if (!configResult.ok) throw new Error('Config failed');
 *
 * const axis = createAxis({
 *   db,
 *   config: configResult.value,
 *   dataDir: './data',
 *   projectRoot: process.cwd(),
 *   processor: async (job, signal) => { ... },
 * });
 *
 * await axis.start();
 * ```
 */
export function createAxis(options: AxisOptions): Axis {
  return new Axis(options);
}
