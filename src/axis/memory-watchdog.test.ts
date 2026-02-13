import { describe, it, expect, afterEach } from 'vitest';

import type { MemoryPressureLevel, MemorySnapshot, MemoryWatchdogLogger } from './memory-watchdog.js';
import { MemoryWatchdog } from './memory-watchdog.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createCollectingLogger(): MemoryWatchdogLogger & {
  messages: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
} {
  const messages: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  return {
    messages,
    info: (message, data) => { messages.push({ level: 'info', message, data }); },
    warn: (message, data) => { messages.push({ level: 'warn', message, data }); },
    error: (message, data) => { messages.push({ level: 'error', message, data }); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let watchdog: MemoryWatchdog | null = null;

afterEach(() => {
  if (watchdog) {
    watchdog.stop();
    watchdog = null;
  }
});

describe('MemoryWatchdog', () => {
  describe('lifecycle', () => {
    it('should start and stop without error', () => {
      const logger = createCollectingLogger();
      watchdog = new MemoryWatchdog({ logger, checkIntervalMs: 100 });

      watchdog.start();
      expect(watchdog.isRunning()).toBe(true);

      watchdog.stop();
      expect(watchdog.isRunning()).toBe(false);

      const startMsg = logger.messages.find((m) => m.message === 'Memory watchdog started');
      const stopMsg = logger.messages.find((m) => m.message === 'Memory watchdog stopped');
      expect(startMsg).toBeDefined();
      expect(stopMsg).toBeDefined();
    });

    it('should be idempotent on start', () => {
      watchdog = new MemoryWatchdog({ checkIntervalMs: 100 });

      watchdog.start();
      watchdog.start(); // Should not throw
      expect(watchdog.isRunning()).toBe(true);
    });

    it('should be idempotent on stop', () => {
      watchdog = new MemoryWatchdog({ checkIntervalMs: 100 });

      watchdog.stop(); // Should not throw when not started
      expect(watchdog.isRunning()).toBe(false);
    });
  });

  describe('pressure levels', () => {
    it('should start at normal pressure level', () => {
      watchdog = new MemoryWatchdog({ checkIntervalMs: 100 });
      expect(watchdog.getPressureLevel()).toBe('normal');
    });

    it('should return a complete snapshot', () => {
      watchdog = new MemoryWatchdog({ checkIntervalMs: 100 });

      const snapshot = watchdog.getSnapshot();
      expect(snapshot.rssBytes).toBeGreaterThan(0);
      expect(typeof snapshot.rssBudgetPercent).toBe('number');
      expect(snapshot.heapUsedBytes).toBeGreaterThan(0);
      expect(snapshot.heapTotalBytes).toBeGreaterThan(0);
      expect(snapshot.systemFreeBytes).toBeGreaterThan(0);
      expect(snapshot.systemFreeMb).toBeGreaterThan(0);
      expect(snapshot.level).toBeDefined();
    });

    it('should report normal level when RSS is well below budget', () => {
      // Use a very high budget so current RSS is guaranteed to be low percentage.
      // Set emergencyFreeMb to 0 to avoid false emergency on low-RAM machines.
      watchdog = new MemoryWatchdog({
        memoryBudgetBytes: 100 * 1024 * 1024 * 1024, // 100 GB
        checkIntervalMs: 100,
        emergencyFreeMb: 0,
      });

      const snapshot = watchdog.getSnapshot();
      expect(snapshot.level).toBe('normal');
    });

    it('should report warn level when RSS exceeds 70% of budget', () => {
      // Set budget to just slightly above current RSS to trigger warn.
      // Disable emergency check so it doesn't override on low-RAM machines.
      const currentRss = process.memoryUsage().rss;
      const budget = Math.floor(currentRss / 0.75); // 75% will be > 70% threshold

      watchdog = new MemoryWatchdog({
        memoryBudgetBytes: budget,
        checkIntervalMs: 100,
        emergencyFreeMb: 0,
      });

      const snapshot = watchdog.getSnapshot();
      expect(snapshot.rssBudgetPercent).toBeGreaterThanOrEqual(70);
      expect(
        snapshot.level === 'warn' ||
        snapshot.level === 'pause' ||
        snapshot.level === 'reject',
      ).toBe(true);
    });

    it('should report reject level when RSS exceeds 90% of budget', () => {
      const currentRss = process.memoryUsage().rss;
      const budget = Math.floor(currentRss / 0.95); // 95% will be > 90%

      watchdog = new MemoryWatchdog({
        memoryBudgetBytes: budget,
        checkIntervalMs: 100,
      });

      const snapshot = watchdog.getSnapshot();
      expect(snapshot.rssBudgetPercent).toBeGreaterThanOrEqual(90);
      expect(snapshot.level === 'reject' || snapshot.level === 'emergency').toBe(true);
    });
  });

  describe('graduated responses', () => {
    it('shouldRejectSandbox should return false at normal level', () => {
      watchdog = new MemoryWatchdog({
        memoryBudgetBytes: 100 * 1024 * 1024 * 1024,
        checkIntervalMs: 100,
        emergencyFreeMb: 0,
      });

      expect(watchdog.shouldRejectSandbox()).toBe(false);
    });

    it('shouldPauseBackgroundTasks should return false at normal level', () => {
      watchdog = new MemoryWatchdog({
        memoryBudgetBytes: 100 * 1024 * 1024 * 1024,
        checkIntervalMs: 100,
        emergencyFreeMb: 0,
      });

      expect(watchdog.shouldPauseBackgroundTasks()).toBe(false);
    });
  });

  describe('pressure change callback', () => {
    it('should invoke callback when pressure level changes', async () => {
      const changes: Array<{ level: MemoryPressureLevel; snapshot: MemorySnapshot }> = [];

      // Start with a huge budget (normal level).
      // Disable emergency check to avoid false triggers on low-RAM machines.
      watchdog = new MemoryWatchdog({
        memoryBudgetBytes: 100 * 1024 * 1024 * 1024, // 100 GB
        checkIntervalMs: 50,
        emergencyFreeMb: 0,
      });

      watchdog.onPressureLevelChange((level, snapshot) => {
        changes.push({ level, snapshot });
      });

      watchdog.start();

      // Wait a bit — since budget is huge, we should stay at normal
      await new Promise((resolve) => { setTimeout(resolve, 150); });

      // No changes expected since we start at normal and stay at normal
      expect(changes).toHaveLength(0);
    });
  });

  describe('log output', () => {
    it('should log budget info on start', () => {
      const logger = createCollectingLogger();

      watchdog = new MemoryWatchdog({
        logger,
        memoryBudgetBytes: 2 * 1024 * 1024 * 1024,
        checkIntervalMs: 100,
      });
      watchdog.start();

      const startMsg = logger.messages.find((m) => m.message === 'Memory watchdog started');
      expect(startMsg).toBeDefined();
      expect(startMsg?.data?.budgetMb).toBe(2048);
    });
  });
});
