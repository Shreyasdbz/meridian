// @meridian/axis — Basic periodic maintenance (Section 8.3)
//
// Runs ANALYZE and INCREMENTAL VACUUM on all databases to keep the
// query planner's statistics current and reclaim disk space. Runs on
// startup and every 24 hours during idle.
//
// Note: Full idle maintenance scheduler with reflection backlog and
// FTS rebuild is Phase 10.6.

import type { DatabaseClient, DatabaseName } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for maintenance events.
 */
export interface MaintenanceLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Options for the basic maintenance scheduler.
 */
export interface MaintenanceOptions {
  /** Database client to run maintenance on. */
  db: DatabaseClient;
  /** Interval in ms between maintenance runs. Default: 24 hours. */
  intervalMs?: number;
  /** Logger for maintenance events. */
  logger?: MaintenanceLogger;
  /** Database names to maintain. Default: ['meridian', 'journal', 'sentinel']. */
  databases?: DatabaseName[];
}

/**
 * Result of a single maintenance run.
 */
export interface MaintenanceRunResult {
  /** Databases that were successfully maintained. */
  succeeded: DatabaseName[];
  /** Databases that failed maintenance with their error messages. */
  failed: Array<{ db: DatabaseName; error: string }>;
  /** Duration of the maintenance run in ms. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maintenance interval: 24 hours. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Default databases to maintain. Audit is excluded as it uses monthly partitioning. */
const DEFAULT_DATABASES: DatabaseName[] = ['meridian', 'journal', 'sentinel'];

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: MaintenanceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// BasicMaintenance
// ---------------------------------------------------------------------------

/**
 * Basic periodic database maintenance.
 *
 * Runs `ANALYZE` and `PRAGMA incremental_vacuum` on configured databases.
 * - `ANALYZE` updates query planner statistics so SQLite can make better
 *   index selection decisions.
 * - `PRAGMA incremental_vacuum` reclaims free pages from databases that
 *   use `auto_vacuum = INCREMENTAL`.
 *
 * Maintenance is non-blocking — it runs in the background and does not
 * interfere with normal operation. Failures are logged but do not
 * propagate.
 */
export class BasicMaintenance {
  private readonly db: DatabaseClient;
  private readonly intervalMs: number;
  private readonly logger: MaintenanceLogger;
  private readonly databases: DatabaseName[];

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: string | undefined;

  constructor(options: MaintenanceOptions) {
    this.db = options.db;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = options.logger ?? noopLogger;
    this.databases = options.databases ?? DEFAULT_DATABASES;
  }

  /**
   * Start the maintenance scheduler. Runs an initial maintenance
   * immediately, then schedules periodic runs.
   */
  async start(): Promise<MaintenanceRunResult> {
    if (this.running) {
      return { succeeded: [], failed: [], durationMs: 0 };
    }

    this.running = true;

    // Run initial maintenance
    const result = await this.runMaintenance();

    // Schedule periodic maintenance
    this.timer = setInterval(() => {
      void this.runMaintenance();
    }, this.intervalMs);

    // Prevent the maintenance timer from keeping the process alive
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    this.logger.info('Maintenance scheduler started', {
      intervalMs: this.intervalMs,
      databases: this.databases,
    });

    return result;
  }

  /**
   * Stop the maintenance scheduler.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('Maintenance scheduler stopped');
  }

  /**
   * Check if the maintenance scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the timestamp of the last maintenance run.
   */
  getLastRunAt(): string | undefined {
    return this.lastRunAt;
  }

  /**
   * Run maintenance on all configured databases.
   * Can be called manually for on-demand maintenance.
   */
  async runMaintenance(): Promise<MaintenanceRunResult> {
    const start = performance.now();
    const result: MaintenanceRunResult = {
      succeeded: [],
      failed: [],
      durationMs: 0,
    };

    this.logger.debug('Starting maintenance run', {
      databases: this.databases,
    });

    for (const dbName of this.databases) {
      try {
        await this.maintainDatabase(dbName);
        result.succeeded.push(dbName);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ db: dbName, error: message });

        this.logger.error('Maintenance failed for database', {
          database: dbName,
          error: message,
        });
      }
    }

    result.durationMs = Math.round(performance.now() - start);
    this.lastRunAt = new Date().toISOString();

    this.logger.info('Maintenance run complete', {
      succeeded: result.succeeded.length,
      failed: result.failed.length,
      durationMs: result.durationMs,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async maintainDatabase(dbName: DatabaseName): Promise<void> {
    this.logger.debug('Running ANALYZE', { database: dbName });
    await this.db.exec(dbName, 'ANALYZE');

    this.logger.debug('Running PRAGMA incremental_vacuum', { database: dbName });
    await this.db.exec(dbName, 'PRAGMA incremental_vacuum');
  }
}
