// @meridian/axis — Configurable worker pool for concurrent job processing
// Architecture Reference: Sections 5.1.4, 5.1.6

import type { Job } from '@meridian/shared';
import { generateId, QUEUE_POLL_INTERVAL_MS } from '@meridian/shared';

import type { JobQueue } from './job-queue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status of an individual worker in the pool.
 */
export type WorkerStatus = 'idle' | 'busy' | 'stopping';

/**
 * Information about a single worker.
 */
export interface WorkerInfo {
  /** Unique worker ID. */
  id: string;
  /** Current worker status. */
  status: WorkerStatus;
  /** The job currently being processed, if any. */
  currentJobId?: string;
  /** Timestamp when the worker started processing the current job. */
  busySince?: number;
}

/**
 * Callback invoked when a worker claims a job for processing.
 *
 * The processor is responsible for driving the job through its lifecycle
 * (planning → validation → execution). The worker pool only handles
 * claim and release; the actual pipeline is orchestrated externally.
 *
 * @param job - The claimed job
 * @param signal - AbortSignal that fires when the pool is shutting down
 */
export type JobProcessor = (job: Job, signal: AbortSignal) => Promise<void>;

/**
 * Logger interface for worker pool events.
 */
export interface WorkerPoolLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Options for configuring the worker pool.
 */
export interface WorkerPoolOptions {
  /** Maximum number of concurrent workers. */
  maxWorkers: number;
  /** Job queue to claim jobs from. */
  queue: JobQueue;
  /** Callback invoked for each claimed job. */
  processor: JobProcessor;
  /** Optional logger. */
  logger?: WorkerPoolLogger;
  /** Queue poll interval in milliseconds (default: QUEUE_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
  /** Backpressure threshold — when active jobs exceed this, new claims pause. */
  backpressureThreshold?: number;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: WorkerPoolLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

/**
 * Configurable worker pool for concurrent job processing.
 *
 * Workers claim jobs from the SQLite queue via atomic CAS (compare-and-swap).
 * Each worker follows the lifecycle: claim → process → release.
 *
 * Backpressure: when the number of active workers reaches maxWorkers,
 * the pool stops polling for new jobs until a worker becomes available.
 */
export class WorkerPool {
  private readonly maxWorkers: number;
  private readonly queue: JobQueue;
  private readonly processor: JobProcessor;
  private readonly logger: WorkerPoolLogger;
  private readonly pollIntervalMs: number;
  private readonly backpressureThreshold: number;

  /** Currently active workers, keyed by worker ID. */
  private readonly workers: Map<string, WorkerInfo> = new Map();
  /** AbortController for coordinated shutdown. */
  private shutdownController: AbortController | null = null;
  /** Polling interval handle. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether the pool is currently running. */
  private running = false;
  /** Promises for active worker jobs (for graceful shutdown). */
  private readonly activeJobs: Map<string, Promise<void>> = new Map();
  /** Whether the pool is in backpressure mode. */
  private backpressureActive = false;

  constructor(options: WorkerPoolOptions) {
    if (options.maxWorkers < 1) {
      throw new Error('maxWorkers must be at least 1');
    }

    this.maxWorkers = options.maxWorkers;
    this.queue = options.queue;
    this.processor = options.processor;
    this.logger = options.logger ?? noopLogger;
    this.pollIntervalMs = options.pollIntervalMs ?? QUEUE_POLL_INTERVAL_MS;
    this.backpressureThreshold = options.backpressureThreshold ?? options.maxWorkers;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the worker pool. Begins polling for jobs.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.shutdownController = new AbortController();

    this.logger.info('Worker pool started', {
      maxWorkers: this.maxWorkers,
      pollIntervalMs: this.pollIntervalMs,
      backpressureThreshold: this.backpressureThreshold,
    });

    // Initial poll, then start interval
    void this.poll();
    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
  }

  /**
   * Stop the worker pool gracefully.
   *
   * 1. Stops accepting new jobs.
   * 2. Signals all active workers via AbortController.
   * 3. Waits for active jobs to complete (up to `graceMs`).
   * 4. Returns the IDs of any jobs that were still running.
   *
   * @param graceMs — Maximum time to wait for active jobs (default: 30_000)
   * @returns Worker IDs of jobs that were still running when grace period expired
   */
  async stop(graceMs = 30_000): Promise<string[]> {
    if (!this.running) {
      return [];
    }

    this.running = false;

    // Stop polling
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.info('Worker pool stopping', {
      activeWorkers: this.workers.size,
      graceMs,
    });

    // Signal all active workers
    this.shutdownController?.abort(new Error('Worker pool shutting down'));

    // Wait for active jobs with grace timeout
    const activePromises = Array.from(this.activeJobs.entries());
    if (activePromises.length === 0) {
      this.logger.info('Worker pool stopped — no active jobs');
      return [];
    }

    const graceTimer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => { resolve('timeout'); }, graceMs);
    });

    const allDone = Promise.allSettled(activePromises.map(([, p]) => p))
      .then(() => 'done' as const);

    const result = await Promise.race([allDone, graceTimer]);

    const stillRunning: string[] = [];
    if (result === 'timeout') {
      for (const [workerId, info] of this.workers) {
        if (info.status === 'busy') {
          stillRunning.push(workerId);
        }
      }
      this.logger.warn('Worker pool grace period expired', {
        stillRunning: stillRunning.length,
      });
    } else {
      this.logger.info('Worker pool stopped gracefully');
    }

    this.workers.clear();
    this.activeJobs.clear();
    this.shutdownController = null;

    return stillRunning;
  }

  // -------------------------------------------------------------------------
  // Polling loop
  // -------------------------------------------------------------------------

  /**
   * Single poll cycle: try to claim jobs for idle workers.
   */
  private async poll(): Promise<void> {
    if (!this.running) {
      return;
    }

    const availableSlots = this.maxWorkers - this.getActiveWorkerCount();

    // Backpressure check
    if (availableSlots <= 0) {
      if (!this.backpressureActive) {
        this.backpressureActive = true;
        this.logger.warn('Backpressure active — all workers busy', {
          maxWorkers: this.maxWorkers,
          activeWorkers: this.getActiveWorkerCount(),
        });
      }
      return;
    }

    if (this.backpressureActive) {
      this.backpressureActive = false;
      this.logger.info('Backpressure released', {
        availableSlots,
      });
    }

    // Try to claim up to `availableSlots` jobs
    for (let i = 0; i < availableSlots; i++) {
      // Runtime guard: stop() may set this.running=false concurrently
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.running) {
        break;
      }

      try {
        await this.tryClaimAndProcess();
      } catch (error: unknown) {
        this.logger.error('Error during job claim', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't let one claim failure break the loop
        break;
      }
    }
  }

  /**
   * Try to claim a single job and start processing it.
   */
  private async tryClaimAndProcess(): Promise<void> {
    const workerId = generateId();

    const job = await this.queue.claimJob(workerId);
    if (!job) {
      return;
    }

    const workerInfo: WorkerInfo = {
      id: workerId,
      status: 'busy',
      currentJobId: job.id,
      busySince: Date.now(),
    };
    this.workers.set(workerId, workerInfo);

    this.logger.info('Worker claimed job', {
      workerId,
      jobId: job.id,
      priority: job.priority,
    });

    // Start processing asynchronously
    // shutdownController is always set when the pool is running (set in start())
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed by start()
    const signal = this.shutdownController!.signal;
    const jobPromise = this.processJob(workerId, job, signal);
    this.activeJobs.set(workerId, jobPromise);
  }

  /**
   * Process a job and release the worker when done.
   */
  private async processJob(
    workerId: string,
    job: Job,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.processor(job, signal);

      this.logger.info('Worker completed job', {
        workerId,
        jobId: job.id,
      });
    } catch (error: unknown) {
      this.logger.error('Worker job processing failed', {
        workerId,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Release worker
      this.workers.delete(workerId);
      this.activeJobs.delete(workerId);
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /**
   * Check if the pool is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of workers currently processing jobs.
   */
  getActiveWorkerCount(): number {
    let count = 0;
    for (const info of this.workers.values()) {
      if (info.status === 'busy') {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the maximum number of concurrent workers.
   */
  getMaxWorkers(): number {
    return this.maxWorkers;
  }

  /**
   * Get information about all current workers.
   */
  getWorkers(): ReadonlyMap<string, WorkerInfo> {
    return this.workers;
  }

  /**
   * Check if the pool is in backpressure mode.
   */
  isBackpressureActive(): boolean {
    return this.backpressureActive;
  }
}
