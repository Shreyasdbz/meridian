// @meridian/axis — Full idle maintenance (Phase 10.6)
//
// Extends BasicMaintenance with Journal-aware tasks:
// - FTS5 rebuild check (if >7 days since last)
// - Staged memory promotion (24-hour window)
// - Retention policy enforcement
// - Daily backup trigger
// - Sentinel Memory expiry pruning
//
// Only runs tasks when no active jobs are present (idle check).

import { applyRetention, FTS_REBUILD_INTERVAL_DAYS } from '@meridian/shared';
import type { DatabaseClient, DatabaseName, RetentionResult  } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for idle maintenance.
 */
export interface IdleMaintenanceLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Callback to check if the system is idle (no active jobs).
 */
export type IdleCheck = () => Promise<boolean>;

/**
 * Callback to promote staged memories that have passed the 24-hour window.
 */
export type StagedMemoryPromoter = () => Promise<number>;

/**
 * Callback to prune expired Sentinel Memory decisions.
 */
export type SentinelPruner = () => Promise<number>;

/**
 * Callback to create a backup.
 */
export type BackupCreator = () => Promise<void>;

/**
 * Options for IdleMaintenance.
 */
export interface IdleMaintenanceOptions {
  /** Database client. */
  db: DatabaseClient;
  /** Interval in ms between maintenance checks. Default: 1 hour. */
  intervalMs?: number;
  /** Logger. */
  logger?: IdleMaintenanceLogger;
  /** Database names to run ANALYZE on. Default: ['meridian', 'journal', 'sentinel']. */
  databases?: DatabaseName[];
  /** Callback to check if the system is idle. */
  isIdle: IdleCheck;
  /** Callback to promote staged memories. Optional. */
  promoteStagedMemories?: StagedMemoryPromoter;
  /** Callback to prune expired Sentinel decisions. Optional. */
  pruneSentinelExpired?: SentinelPruner;
  /** Callback to create a backup. Optional. */
  createBackup?: BackupCreator;
}

/**
 * Result of an idle maintenance run.
 */
export interface IdleMaintenanceResult {
  /** Whether the run was skipped because the system was not idle. */
  skipped: boolean;
  /** Basic maintenance results. */
  analyzeSucceeded: DatabaseName[];
  analyzeFailed: Array<{ db: DatabaseName; error: string }>;
  /** FTS rebuild result. */
  ftsRebuilt: boolean;
  /** Staged memories promoted. */
  stagedMemoriesPromoted: number;
  /** Sentinel decisions pruned. */
  sentinelDecisionsPruned: number;
  /** Retention enforcement result. */
  retention?: RetentionResult;
  /** Whether backup was created. */
  backupCreated: boolean;
  /** Duration in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default check interval: 1 hour. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;

/** FTS rebuild interval derived from shared constant (7 days). */
const FTS_REBUILD_INTERVAL_MS = FTS_REBUILD_INTERVAL_DAYS * 24 * 60 * 60 * 1_000;

/** Default databases for ANALYZE. */
const DEFAULT_DATABASES: DatabaseName[] = ['meridian', 'journal', 'sentinel'];

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: IdleMaintenanceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// IdleMaintenance
// ---------------------------------------------------------------------------

/**
 * Full idle maintenance scheduler.
 *
 * Extends the basic ANALYZE + incremental_vacuum with:
 * - FTS5 OPTIMIZE (if 7+ days since last)
 * - Staged memory promotion (24-hour window)
 * - Data retention enforcement
 * - Daily backup trigger
 * - Sentinel Memory expiry pruning
 *
 * All additional tasks only run when the system is idle (no active jobs).
 */
export class IdleMaintenance {
  private readonly db: DatabaseClient;
  private readonly intervalMs: number;
  private readonly logger: IdleMaintenanceLogger;
  private readonly databases: DatabaseName[];
  private readonly isIdle: IdleCheck;
  private readonly promoteStagedMemories?: StagedMemoryPromoter;
  private readonly pruneSentinelExpired?: SentinelPruner;
  private readonly createBackup?: BackupCreator;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: string | undefined;
  private lastFtsRebuildAt: number | undefined;

  constructor(options: IdleMaintenanceOptions) {
    this.db = options.db;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = options.logger ?? noopLogger;
    this.databases = options.databases ?? DEFAULT_DATABASES;
    this.isIdle = options.isIdle;
    this.promoteStagedMemories = options.promoteStagedMemories;
    this.pruneSentinelExpired = options.pruneSentinelExpired;
    this.createBackup = options.createBackup;
  }

  /**
   * Start the maintenance scheduler.
   */
  async start(): Promise<IdleMaintenanceResult> {
    if (this.running) {
      return this.emptyResult(true);
    }

    this.running = true;

    // Run initial maintenance
    const result = await this.runMaintenance();

    // Schedule periodic runs
    this.timer = setInterval(() => {
      void this.runMaintenance();
    }, this.intervalMs);

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    this.logger.info('Idle maintenance scheduler started', {
      intervalMs: this.intervalMs,
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

    this.logger.info('Idle maintenance scheduler stopped');
  }

  /**
   * Check if the scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get timestamp of the last maintenance run.
   */
  getLastRunAt(): string | undefined {
    return this.lastRunAt;
  }

  /**
   * Run a full maintenance cycle.
   *
   * 1. Check idle status — skip if system is busy
   * 2. ANALYZE + incremental_vacuum on all databases
   * 3. FTS5 OPTIMIZE if 7+ days since last
   * 4. Promote staged memories past 24-hour window
   * 5. Prune expired Sentinel decisions
   * 6. Apply data retention policies
   * 7. Trigger backup (if configured)
   */
  async runMaintenance(): Promise<IdleMaintenanceResult> {
    const start = performance.now();

    // 1. Idle check
    let idle = false;
    try {
      idle = await this.isIdle();
    } catch (error) {
      this.logger.error('Idle check failed, skipping maintenance', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.emptyResult(true);
    }

    if (!idle) {
      this.logger.debug('System not idle, skipping maintenance');
      return this.emptyResult(true);
    }

    const result: IdleMaintenanceResult = {
      skipped: false,
      analyzeSucceeded: [],
      analyzeFailed: [],
      ftsRebuilt: false,
      stagedMemoriesPromoted: 0,
      sentinelDecisionsPruned: 0,
      retention: undefined,
      backupCreated: false,
      durationMs: 0,
    };

    // 2. Basic maintenance: ANALYZE + incremental_vacuum
    for (const dbName of this.databases) {
      try {
        await this.db.exec(dbName, 'ANALYZE');
        await this.db.exec(dbName, 'PRAGMA incremental_vacuum');
        result.analyzeSucceeded.push(dbName);
      } catch (error) {
        result.analyzeFailed.push({
          db: dbName,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.error('ANALYZE failed', {
          database: dbName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 3. FTS5 OPTIMIZE (if 7+ days since last)
    try {
      const shouldRebuild =
        this.lastFtsRebuildAt === undefined ||
        Date.now() - this.lastFtsRebuildAt >= FTS_REBUILD_INTERVAL_MS;

      if (shouldRebuild) {
        await this.rebuildFts();
        result.ftsRebuilt = true;
        this.lastFtsRebuildAt = Date.now();
      }
    } catch (error) {
      this.logger.error('FTS rebuild failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 4. Promote staged memories
    if (this.promoteStagedMemories) {
      try {
        result.stagedMemoriesPromoted = await this.promoteStagedMemories();
        if (result.stagedMemoriesPromoted > 0) {
          this.logger.info('Promoted staged memories', {
            count: result.stagedMemoriesPromoted,
          });
        }
      } catch (error) {
        this.logger.error('Staged memory promotion failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 5. Prune expired Sentinel decisions
    if (this.pruneSentinelExpired) {
      try {
        result.sentinelDecisionsPruned = await this.pruneSentinelExpired();
        if (result.sentinelDecisionsPruned > 0) {
          this.logger.info('Pruned expired Sentinel decisions', {
            count: result.sentinelDecisionsPruned,
          });
        }
      } catch (error) {
        this.logger.error('Sentinel pruning failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 6. Apply data retention policies
    try {
      result.retention = await applyRetention({ db: this.db, logger: this.logger });
    } catch (error) {
      this.logger.error('Retention enforcement failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 7. Trigger backup
    if (this.createBackup) {
      try {
        await this.createBackup();
        result.backupCreated = true;
        this.logger.info('Backup created during maintenance');
      } catch (error) {
        this.logger.error('Backup creation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.durationMs = Math.round(performance.now() - start);
    this.lastRunAt = new Date().toISOString();

    this.logger.info('Idle maintenance complete', {
      durationMs: result.durationMs,
      analyzeSucceeded: result.analyzeSucceeded.length,
      ftsRebuilt: result.ftsRebuilt,
      stagedMemoriesPromoted: result.stagedMemoriesPromoted,
      sentinelDecisionsPruned: result.sentinelDecisionsPruned,
      backupCreated: result.backupCreated,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Run FTS5 OPTIMIZE on all FTS tables in journal.db.
   */
  private async rebuildFts(): Promise<void> {
    const ftsTables = ['episodes_fts', 'facts_fts', 'procedures_fts'];
    for (const table of ftsTables) {
      try {
        await this.db.exec('journal', `INSERT INTO ${table}(${table}) VALUES('optimize')`);
        this.logger.debug('FTS OPTIMIZE complete', { table });
      } catch (error) {
        // FTS table might not exist if journal hasn't been initialized
        this.logger.debug('FTS OPTIMIZE skipped (table may not exist)', {
          table,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private emptyResult(skipped: boolean): IdleMaintenanceResult {
    return {
      skipped,
      analyzeSucceeded: [],
      analyzeFailed: [],
      ftsRebuilt: false,
      stagedMemoriesPromoted: 0,
      sentinelDecisionsPruned: 0,
      retention: undefined,
      backupCreated: false,
      durationMs: 0,
    };
  }
}
