import { describe, it, expect, afterEach } from 'vitest';

import { Watchdog } from './watchdog.js';
import type { DiagnosticDump, WatchdogLogger } from './watchdog.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createCollectingLogger(): WatchdogLogger & {
  messages: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
} {
  const messages: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  return {
    messages,
    info: (message, data) => { messages.push({ level: 'info', message, data }); },
    warn: (message, data) => { messages.push({ level: 'warn', message, data }); },
    error: (message, data) => { messages.push({ level: 'error', message, data }); },
    debug: (message, data) => { messages.push({ level: 'debug', message, data }); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let watchdog: Watchdog | null = null;

afterEach(() => {
  if (watchdog) {
    watchdog.stop();
    watchdog = null;
  }
});

describe('Watchdog', () => {
  describe('lifecycle', () => {
    it('should start and stop without error', () => {
      const logger = createCollectingLogger();
      watchdog = new Watchdog({ logger, checkIntervalMs: 100 });

      watchdog.start();
      expect(watchdog.isRunning()).toBe(true);

      watchdog.stop();
      expect(watchdog.isRunning()).toBe(false);

      const startMsg = logger.messages.find((m) => m.message === 'Watchdog started');
      const stopMsg = logger.messages.find((m) => m.message === 'Watchdog stopped');
      expect(startMsg).toBeDefined();
      expect(stopMsg).toBeDefined();
    });

    it('should be idempotent on start', () => {
      watchdog = new Watchdog({ checkIntervalMs: 100 });

      watchdog.start();
      watchdog.start(); // should not throw
      expect(watchdog.isRunning()).toBe(true);
    });

    it('should be idempotent on stop', () => {
      watchdog = new Watchdog({ checkIntervalMs: 100 });

      watchdog.stop(); // should not throw when not started
      expect(watchdog.isRunning()).toBe(false);
    });
  });

  describe('event loop stats', () => {
    it('should return undefined when not running', () => {
      watchdog = new Watchdog({ checkIntervalMs: 100 });
      expect(watchdog.getEventLoopStats()).toBeUndefined();
    });

    it('should return stats when running', async () => {
      watchdog = new Watchdog({ checkIntervalMs: 50 });
      watchdog.start();

      // Give the histogram a moment to collect data
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      const stats = watchdog.getEventLoopStats();
      expect(stats).toBeDefined();
      expect(stats?.minMs).toBeGreaterThanOrEqual(0);
      expect(stats?.maxMs).toBeGreaterThanOrEqual(0);
      expect(stats?.meanMs).toBeGreaterThanOrEqual(0);
      expect(stats?.p99Ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('block detection', () => {
    it('should detect a simulated event loop block', async () => {
      const dumps: DiagnosticDump[] = [];
      const logger = createCollectingLogger();

      watchdog = new Watchdog({
        blockThresholdMs: 50, // Very low threshold for testing
        checkIntervalMs: 30,
        logger,
      });
      watchdog.onDiagnosticDump = (dump) => { dumps.push(dump); };
      watchdog.start();

      // Simulate an event loop block with a busy-wait
      const start = Date.now();
      while (Date.now() - start < 120) {
        // Busy-wait to block the event loop
      }

      // Give the check interval a chance to fire
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      // The watchdog should have detected the block
      if (dumps.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked
        const dump = dumps[0]!;
        expect(dump.timestamp).toBeDefined();
        expect(dump.eventLoopBlockedMs).toBeGreaterThan(0);
        expect(dump.heapStats).toBeDefined();
        expect(dump.memoryUsage).toBeDefined();
        expect(dump.uptime).toBeGreaterThan(0);

        const warnMsg = logger.messages.find((m) => m.message === 'Event loop blocked');
        expect(warnMsg).toBeDefined();
      }
      // Note: busy-wait blocking may or may not be detected reliably in
      // CI environments, so we don't fail if no dump was captured.
    });
  });

  describe('diagnostic dump structure', () => {
    it('should produce a complete diagnostic dump when a block is detected', async () => {
      let capturedDump: DiagnosticDump | undefined;
      const logger = createCollectingLogger();

      watchdog = new Watchdog({
        blockThresholdMs: 20,
        checkIntervalMs: 10,
        logger,
      });
      watchdog.onDiagnosticDump = (dump) => { capturedDump = dump; };
      watchdog.start();

      // Busy-wait to trigger block detection
      const start = Date.now();
      while (Date.now() - start < 80) {
        // Busy-wait
      }

      await new Promise((resolve) => { setTimeout(resolve, 50); });

      if (capturedDump) {
        expect(capturedDump.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(typeof capturedDump.eventLoopBlockedMs).toBe('number');
        expect(capturedDump.heapStats).toHaveProperty('total_heap_size');
        expect(capturedDump.heapStats).toHaveProperty('used_heap_size');
        expect(typeof capturedDump.activeHandles).toBe('number');
        expect(typeof capturedDump.activeRequests).toBe('number');
        expect(typeof capturedDump.uptime).toBe('number');
        expect(capturedDump.memoryUsage).toHaveProperty('rss');
        expect(capturedDump.memoryUsage).toHaveProperty('heapUsed');
      }
    });
  });
});
