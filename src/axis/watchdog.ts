// @meridian/axis — Event loop watchdog (Section 5.1.12)
//
// Monitors event loop responsiveness. If the event loop is blocked for
// longer than the configured threshold (default: 10s), logs a warning
// and triggers a diagnostic dump with active handles, pending callbacks,
// and heap stats.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';

import {
  WATCHDOG_BLOCK_THRESHOLD_MS,
  EVENT_LOOP_P99_WARN_MS,
  EVENT_LOOP_P99_ERROR_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for watchdog events.
 */
export interface WatchdogLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Options for configuring the watchdog.
 */
export interface WatchdogOptions {
  /** Threshold in ms for event loop block detection. Default: WATCHDOG_BLOCK_THRESHOLD_MS (10s). */
  blockThresholdMs?: number;
  /** Polling interval in ms for the event loop check. Default: 1000. */
  checkIntervalMs?: number;
  /** Logger for watchdog events. */
  logger?: WatchdogLogger;
}

/**
 * Diagnostic snapshot captured when an event loop block is detected.
 */
export interface DiagnosticDump {
  timestamp: string;
  eventLoopBlockedMs: number;
  heapStats: v8.HeapInfo;
  activeHandles: number;
  activeRequests: number;
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: WatchdogLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

/**
 * Event loop watchdog that detects blocked event loops and captures
 * diagnostic information.
 *
 * The watchdog uses two mechanisms:
 * 1. A `setInterval` heartbeat that checks if the event loop has been
 *    blocked (by comparing actual elapsed time vs expected interval).
 * 2. Node.js `monitorEventLoopDelay` for p99 latency monitoring.
 */
export class Watchdog {
  private readonly blockThresholdMs: number;
  private readonly checkIntervalMs: number;
  private readonly logger: WatchdogLogger;

  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private lastCheckTime: number = 0;
  private running = false;
  private eldHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

  /** Callback invoked when a diagnostic dump is captured. For testing. */
  onDiagnosticDump?: (dump: DiagnosticDump) => void;

  constructor(options?: WatchdogOptions) {
    this.blockThresholdMs = options?.blockThresholdMs ?? WATCHDOG_BLOCK_THRESHOLD_MS;
    this.checkIntervalMs = options?.checkIntervalMs ?? 1_000;
    this.logger = options?.logger ?? noopLogger;
  }

  /**
   * Start the watchdog. Begins monitoring the event loop.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.lastCheckTime = Date.now();

    // Start event loop delay histogram
    this.eldHistogram = monitorEventLoopDelay({ resolution: 20 });
    this.eldHistogram.enable();

    // Start periodic check
    this.checkTimer = setInterval(() => {
      this.check();
    }, this.checkIntervalMs);

    // Prevent the watchdog timer from keeping the process alive
    if (typeof this.checkTimer === 'object' && 'unref' in this.checkTimer) {
      this.checkTimer.unref();
    }

    this.logger.info('Watchdog started', {
      blockThresholdMs: this.blockThresholdMs,
      checkIntervalMs: this.checkIntervalMs,
    });
  }

  /**
   * Stop the watchdog. Ceases all monitoring.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.eldHistogram) {
      this.eldHistogram.disable();
      this.eldHistogram = null;
    }

    this.logger.info('Watchdog stopped');
  }

  /**
   * Check if the watchdog is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get event loop delay statistics.
   * Returns undefined if the watchdog is not running.
   */
  getEventLoopStats(): {
    minMs: number;
    maxMs: number;
    meanMs: number;
    p99Ms: number;
  } | undefined {
    if (!this.eldHistogram) {
      return undefined;
    }

    return {
      minMs: this.eldHistogram.min / 1e6,
      maxMs: this.eldHistogram.max / 1e6,
      meanMs: this.eldHistogram.mean / 1e6,
      p99Ms: this.eldHistogram.percentile(99) / 1e6,
    };
  }

  // -------------------------------------------------------------------------
  // Internal check loop
  // -------------------------------------------------------------------------

  private check(): void {
    const now = Date.now();
    const elapsed = now - this.lastCheckTime;
    const expectedInterval = this.checkIntervalMs;

    // The event loop was blocked if elapsed time significantly exceeds
    // the expected interval. We use the block threshold to determine
    // "significantly".
    const blockTime = elapsed - expectedInterval;

    if (blockTime >= this.blockThresholdMs) {
      this.onBlockDetected(blockTime);
    }

    // Also check p99 latency from the histogram
    this.checkP99Latency();

    this.lastCheckTime = now;
  }

  private onBlockDetected(blockTimeMs: number): void {
    const dump = this.captureDiagnosticDump(blockTimeMs);

    this.logger.warn('Event loop blocked', {
      blockedMs: Math.round(blockTimeMs),
      heapUsedMb: Math.round(dump.heapStats.used_heap_size / (1024 * 1024)),
      heapTotalMb: Math.round(dump.heapStats.total_heap_size / (1024 * 1024)),
      activeHandles: dump.activeHandles,
      activeRequests: dump.activeRequests,
      rssMb: Math.round(dump.memoryUsage.rss / (1024 * 1024)),
    });

    this.onDiagnosticDump?.(dump);
  }

  private checkP99Latency(): void {
    if (!this.eldHistogram) {
      return;
    }

    const p99Ms = this.eldHistogram.percentile(99) / 1e6;

    if (p99Ms > EVENT_LOOP_P99_ERROR_MS) {
      this.logger.error('Event loop p99 latency exceeds error threshold', {
        p99Ms: Math.round(p99Ms * 100) / 100,
        thresholdMs: EVENT_LOOP_P99_ERROR_MS,
      });
    } else if (p99Ms > EVENT_LOOP_P99_WARN_MS) {
      this.logger.warn('Event loop p99 latency exceeds warning threshold', {
        p99Ms: Math.round(p99Ms * 100) / 100,
        thresholdMs: EVENT_LOOP_P99_WARN_MS,
      });
    }
  }

  /**
   * Capture a diagnostic dump with current system state.
   */
  private captureDiagnosticDump(blockTimeMs: number): DiagnosticDump {
    return {
      timestamp: new Date().toISOString(),
      eventLoopBlockedMs: Math.round(blockTimeMs),
      heapStats: v8.getHeapStatistics(),
      activeHandles: (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
        ._getActiveHandles?.().length ?? -1,
      activeRequests: (process as NodeJS.Process & { _getActiveRequests?: () => unknown[] })
        ._getActiveRequests?.().length ?? -1,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };
  }
}
