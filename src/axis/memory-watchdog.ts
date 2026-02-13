// @meridian/axis — Memory watchdog with graduated responses (Section 11.4)
//
// Monitors process RSS and system free memory. Takes increasingly aggressive
// actions as memory pressure increases:
//
// | Threshold                   | Action                                                    |
// |-----------------------------|-----------------------------------------------------------|
// | RSS > 70% of budget         | Log warning, request incremental GC                       |
// | RSS > 80% of budget         | Pause non-critical background tasks                       |
// | RSS > 90% of budget         | Reject new Gear sandbox creation, queue jobs               |
// | System free < 256 MB        | Emergency: terminate sandboxes, force GC, critical alert   |

import os from 'node:os';
import v8 from 'node:v8';

import {
  MEMORY_RSS_WARN_PERCENT,
  MEMORY_RSS_PAUSE_PERCENT,
  MEMORY_RSS_REJECT_PERCENT,
  MEMORY_EMERGENCY_FREE_MB,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryPressureLevel = 'normal' | 'warn' | 'pause' | 'reject' | 'emergency';

export interface MemoryWatchdogLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface MemoryWatchdogOptions {
  /** Memory budget in bytes. Default: --max-old-space-size or 2 GB. */
  memoryBudgetBytes?: number;
  /** Check interval in ms. Default: 5000. */
  checkIntervalMs?: number;
  /** Logger. */
  logger?: MemoryWatchdogLogger;
  /** RSS warn threshold percent. Default: 70. */
  warnPercent?: number;
  /** RSS pause threshold percent. Default: 80. */
  pausePercent?: number;
  /** RSS reject threshold percent. Default: 90. */
  rejectPercent?: number;
  /** Emergency free memory threshold in MB. Default: 256. */
  emergencyFreeMb?: number;
}

export interface MemorySnapshot {
  rssBytes: number;
  rssBudgetPercent: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  systemFreeBytes: number;
  systemFreeMb: number;
  level: MemoryPressureLevel;
}

/**
 * Callback invoked when the memory pressure level changes.
 */
export type MemoryPressureCallback = (level: MemoryPressureLevel, snapshot: MemorySnapshot) => void;

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: MemoryWatchdogLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// MemoryWatchdog
// ---------------------------------------------------------------------------

/**
 * Memory watchdog that monitors RSS and system free memory with graduated
 * responses per Section 11.4.
 */
export class MemoryWatchdog {
  private readonly memoryBudgetBytes: number;
  private readonly checkIntervalMs: number;
  private readonly logger: MemoryWatchdogLogger;
  private readonly warnPercent: number;
  private readonly pausePercent: number;
  private readonly rejectPercent: number;
  private readonly emergencyFreeMb: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private currentLevel: MemoryPressureLevel = 'normal';
  private onPressureChange?: MemoryPressureCallback;

  constructor(options?: MemoryWatchdogOptions) {
    this.memoryBudgetBytes = options?.memoryBudgetBytes ?? getDefaultMemoryBudget();
    this.checkIntervalMs = options?.checkIntervalMs ?? 5_000;
    this.logger = options?.logger ?? noopLogger;
    this.warnPercent = options?.warnPercent ?? MEMORY_RSS_WARN_PERCENT;
    this.pausePercent = options?.pausePercent ?? MEMORY_RSS_PAUSE_PERCENT;
    this.rejectPercent = options?.rejectPercent ?? MEMORY_RSS_REJECT_PERCENT;
    this.emergencyFreeMb = options?.emergencyFreeMb ?? MEMORY_EMERGENCY_FREE_MB;
  }

  /**
   * Register a callback for memory pressure level changes.
   */
  onPressureLevelChange(callback: MemoryPressureCallback): void {
    this.onPressureChange = callback;
  }

  /**
   * Start the memory watchdog.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.currentLevel = 'normal';

    this.timer = setInterval(() => {
      this.check();
    }, this.checkIntervalMs);

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    this.logger.info('Memory watchdog started', {
      budgetMb: Math.round(this.memoryBudgetBytes / (1024 * 1024)),
      checkIntervalMs: this.checkIntervalMs,
    });
  }

  /**
   * Stop the memory watchdog.
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('Memory watchdog stopped');
  }

  /**
   * Check if the watchdog is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current memory pressure level.
   */
  getPressureLevel(): MemoryPressureLevel {
    return this.currentLevel;
  }

  /**
   * Get a snapshot of current memory state.
   */
  getSnapshot(): MemorySnapshot {
    const mem = process.memoryUsage();
    const systemFreeBytes = os.freemem();
    const systemFreeMb = systemFreeBytes / (1024 * 1024);
    const rssBudgetPercent = (mem.rss / this.memoryBudgetBytes) * 100;

    return {
      rssBytes: mem.rss,
      rssBudgetPercent,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      systemFreeBytes,
      systemFreeMb,
      level: this.computeLevel(rssBudgetPercent, systemFreeMb),
    };
  }

  /**
   * Whether new Gear sandboxes should be rejected (level >= reject).
   */
  shouldRejectSandbox(): boolean {
    return this.currentLevel === 'reject' || this.currentLevel === 'emergency';
  }

  /**
   * Whether non-critical background tasks should be paused (level >= pause).
   */
  shouldPauseBackgroundTasks(): boolean {
    return this.currentLevel === 'pause' || this.currentLevel === 'reject' || this.currentLevel === 'emergency';
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private check(): void {
    const snapshot = this.getSnapshot();
    const newLevel = snapshot.level;

    if (newLevel !== this.currentLevel) {
      this.currentLevel = newLevel;
      this.onLevelChange(newLevel, snapshot);
    }
  }

  private computeLevel(rssBudgetPercent: number, systemFreeMb: number): MemoryPressureLevel {
    // Emergency check first (system-wide)
    if (systemFreeMb < this.emergencyFreeMb) {
      return 'emergency';
    }

    // RSS-based graduated responses
    if (rssBudgetPercent >= this.rejectPercent) {
      return 'reject';
    }
    if (rssBudgetPercent >= this.pausePercent) {
      return 'pause';
    }
    if (rssBudgetPercent >= this.warnPercent) {
      return 'warn';
    }

    return 'normal';
  }

  private onLevelChange(level: MemoryPressureLevel, snapshot: MemorySnapshot): void {
    const rssMb = Math.round(snapshot.rssBytes / (1024 * 1024));
    const budgetMb = Math.round(this.memoryBudgetBytes / (1024 * 1024));
    const data = {
      level,
      rssMb,
      budgetMb,
      rssBudgetPercent: Math.round(snapshot.rssBudgetPercent),
      systemFreeMb: Math.round(snapshot.systemFreeMb),
    };

    switch (level) {
      case 'warn':
        this.logger.warn('Memory pressure: warning — requesting incremental GC', data);
        this.requestIncrementalGc();
        break;

      case 'pause':
        this.logger.warn('Memory pressure: pausing non-critical background tasks', data);
        break;

      case 'reject':
        this.logger.error('Memory pressure: rejecting new Gear sandboxes', data);
        break;

      case 'emergency':
        this.logger.error('Memory pressure: EMERGENCY — forcing GC and terminating sandboxes', data);
        this.forceGc();
        break;

      case 'normal':
        this.logger.info('Memory pressure returned to normal', data);
        break;
    }

    this.onPressureChange?.(level, snapshot);
  }

  private requestIncrementalGc(): void {
    // global.gc is available when Node.js is started with --expose-gc.
    // In production, this is a hint only. If gc() is not available, we
    // use v8.writeHeapSnapshot as a no-op since we cannot force GC.
    if (typeof global.gc === 'function') {
      global.gc({ type: 'minor' });
    }
  }

  private forceGc(): void {
    if (typeof global.gc === 'function') {
      global.gc();
    }
    // Also shrink the old space
    try {
      v8.setFlagsFromString('--gc-global');
    } catch {
      // Flag may not be settable at runtime
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the default memory budget based on V8's max old space size.
 * Falls back to 2 GB if not determinable.
 */
function getDefaultMemoryBudget(): number {
  const stats = v8.getHeapStatistics();
  // heap_size_limit is the configured --max-old-space-size
  if (stats.heap_size_limit > 0) {
    return stats.heap_size_limit;
  }
  // Fallback: 2 GB
  return 2 * 1024 * 1024 * 1024;
}
