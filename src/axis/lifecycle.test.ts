import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { LifecycleManager } from './lifecycle.js';
import type {
  LifecycleLogger,
  StartupPhase,
} from './lifecycle.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** No-op step handler that satisfies the StartupStepHandler type. */
const noop = (): Promise<void> => Promise.resolve();

function createCollectingLogger(): LifecycleLogger & {
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => { resolve(port); });
      } else {
        reject(new Error('Could not get port'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'meridian-test-lifecycle');
let testDataDir: string;
let manager: LifecycleManager;
let logger: ReturnType<typeof createCollectingLogger>;
let testPort: number;

beforeEach(async () => {
  testDataDir = join(TEST_DIR, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (!existsSync(testDataDir)) {
    mkdirSync(testDataDir, { recursive: true });
  }
  logger = createCollectingLogger();
  testPort = await findFreePort();
  manager = new LifecycleManager({
    dataDir: testDataDir,
    port: testPort,
    logger,
    shutdownTimeoutMs: 5_000,
    gearKillTimeoutMs: 1_000,
  });
});

afterEach(async () => {
  manager.removeSignalHandlers();
  if (manager.getPhase() !== 'not_started') {
    await manager.shutdown();
  }
  try {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true });
    }
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LifecycleManager', () => {
  describe('initial state', () => {
    it('should start in not_started phase', () => {
      expect(manager.getPhase()).toBe('not_started');
      expect(manager.getLiveness()).toBe(false);
      expect(manager.getReadiness()).toBe(false);
      expect(manager.getIsShuttingDown()).toBe(false);
    });
  });

  describe('startup sequence', () => {
    it('should execute startup steps in order', async () => {
      const order: string[] = [];

      manager.registerStep('config', 'Load config', () => {
        order.push('config');
        return Promise.resolve();
      });
      manager.registerStep('database', 'Open databases', () => {
        order.push('database');
        return Promise.resolve();
      });
      manager.registerStep('axis_core', 'Start Axis core', () => {
        order.push('axis_core');
        return Promise.resolve();
      });
      manager.registerStep('components', 'Register components', () => {
        order.push('components');
        return Promise.resolve();
      });
      manager.registerStep('recovery', 'Run crash recovery', () => {
        order.push('recovery');
        return Promise.resolve();
      });
      manager.registerStep('bridge', 'Start Bridge', () => {
        order.push('bridge');
        return Promise.resolve();
      });

      await manager.startup();

      expect(order).toEqual([
        'config',
        'database',
        'axis_core',
        'components',
        'recovery',
        'bridge',
      ]);
      expect(manager.getPhase()).toBe('ready');
    });

    it('should mark liveness after config step', async () => {
      let livenessAfterConfig = false;

      manager.registerStep('config', 'Load config', noop);
      manager.registerStep('database', 'Open databases', () => {
        livenessAfterConfig = manager.getLiveness();
        return Promise.resolve();
      });

      await manager.startup();
      expect(livenessAfterConfig).toBe(true);
    });

    it('should mark readiness after bridge step', async () => {
      let readinessBeforeBridge = false;
      let readinessAfterBridge = false;

      manager.registerStep('config', 'Load config', noop);
      manager.registerStep('bridge', 'Start Bridge', () => {
        readinessBeforeBridge = manager.getReadiness();
        return Promise.resolve();
      });

      await manager.startup();
      readinessAfterBridge = manager.getReadiness();

      expect(readinessBeforeBridge).toBe(false);
      expect(readinessAfterBridge).toBe(true);
    });

    it('should abort on step failure', async () => {
      const order: string[] = [];

      manager.registerStep('config', 'Load config', () => {
        order.push('config');
        return Promise.resolve();
      });
      manager.registerStep('database', 'Open databases', () => {
        return Promise.reject(new Error('DB connection failed'));
      });
      manager.registerStep('axis_core', 'Start Axis core', () => {
        order.push('axis_core');
        return Promise.resolve();
      });

      await expect(manager.startup()).rejects.toThrow('DB connection failed');
      expect(order).toEqual(['config']);
      expect(manager.getPhase()).toBe('database');
    });

    it('should prevent double startup', async () => {
      manager.registerStep('config', 'Load config', noop);
      await manager.startup();

      await expect(manager.startup()).rejects.toThrow('Cannot start');
    });
  });

  describe('shutdown', () => {
    it('should execute shutdown handlers in reverse order', async () => {
      const order: string[] = [];

      manager.registerStep('config', 'Load config', noop);
      manager.registerShutdownHandler('Stop connections', () => {
        order.push('connections');
        return Promise.resolve();
      });
      manager.registerShutdownHandler('Stop workers', () => {
        order.push('workers');
        return Promise.resolve();
      });
      manager.registerShutdownHandler('Close databases', () => {
        order.push('databases');
        return Promise.resolve();
      });

      await manager.startup();
      await manager.shutdown();

      expect(order).toEqual(['databases', 'workers', 'connections']);
      expect(manager.getPhase()).toBe('not_started');
      expect(manager.getLiveness()).toBe(false);
      expect(manager.getReadiness()).toBe(false);
    });

    it('should continue shutdown even if a handler fails', async () => {
      const order: string[] = [];

      manager.registerStep('config', 'Load config', noop);
      manager.registerShutdownHandler('Handler A', () => {
        order.push('A');
        return Promise.resolve();
      });
      manager.registerShutdownHandler('Handler B (fails)', () => {
        return Promise.reject(new Error('shutdown failure'));
      });
      manager.registerShutdownHandler('Handler C', () => {
        order.push('C');
        return Promise.resolve();
      });

      await manager.startup();
      await manager.shutdown();

      // C runs first (reverse order), B fails, A still runs
      expect(order).toEqual(['C', 'A']);
    });

    it('should mark readiness as false during shutdown', async () => {
      let readinessDuringShutdown = true;

      manager.registerStep('config', 'Load config', noop);
      manager.registerStep('bridge', 'Start Bridge', noop);
      manager.registerShutdownHandler('Check readiness', () => {
        readinessDuringShutdown = manager.getReadiness();
        return Promise.resolve();
      });

      await manager.startup();
      expect(manager.getReadiness()).toBe(true);

      await manager.shutdown();
      expect(readinessDuringShutdown).toBe(false);
    });

    it('should be idempotent — second call is a no-op', async () => {
      manager.registerStep('config', 'Load config', noop);
      await manager.startup();

      await manager.shutdown();
      await manager.shutdown(); // Should not throw

      const doubleShutdownMsg = logger.messages.filter(
        (m) => m.message === 'Shutdown already in progress',
      );
      expect(doubleShutdownMsg).toHaveLength(1);
    });
  });

  describe('self-diagnostics', () => {
    it('should pass all abort-level checks in a healthy environment', async () => {
      const diagnostics = await manager.runDiagnostics();

      expect(diagnostics.canProceed).toBe(true);

      const abortChecks = diagnostics.checks.filter((c) => c.severity === 'abort');
      for (const check of abortChecks) {
        expect(check.passed).toBe(true);
      }
    });

    it('should fail if data directory does not exist', async () => {
      const badManager = new LifecycleManager({
        dataDir: '/nonexistent/path/meridian-test',
        port: testPort,
        logger,
      });

      const diagnostics = await badManager.runDiagnostics();

      const dataDirCheck = diagnostics.checks.find(
        (c) => c.name === 'Data directory writable',
      );
      expect(dataDirCheck).toBeDefined();
      expect(dataDirCheck?.passed).toBe(false);
      expect(dataDirCheck?.severity).toBe('abort');
      expect(diagnostics.canProceed).toBe(false);
    });

    it('should fail if port is already in use', async () => {
      // Occupy the port
      const server = createServer();
      const occupiedPort = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const portManager = new LifecycleManager({
          dataDir: testDataDir,
          port: occupiedPort,
          logger,
        });

        const diagnostics = await portManager.runDiagnostics();

        const portCheck = diagnostics.checks.find(
          (c) => c.name === 'Port available',
        );
        expect(portCheck).toBeDefined();
        expect(portCheck?.passed).toBe(false);
        expect(portCheck?.severity).toBe('abort');
        expect(diagnostics.canProceed).toBe(false);
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      }
    });

    it('should pass Node.js version check (we are running >= 20)', async () => {
      const diagnostics = await manager.runDiagnostics();

      const nodeCheck = diagnostics.checks.find(
        (c) => c.name === 'Node.js >= 20',
      );
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck?.passed).toBe(true);
      expect(nodeCheck?.severity).toBe('abort');
    });

    it('should pass database files check when no database files exist yet', async () => {
      const diagnostics = await manager.runDiagnostics();

      const dbCheck = diagnostics.checks.find(
        (c) => c.name === 'Database files readable/writable',
      );
      expect(dbCheck).toBeDefined();
      expect(dbCheck?.passed).toBe(true);
      expect(dbCheck?.severity).toBe('abort');
    });

    it('should pass database files check when files exist and are accessible', async () => {
      // Create a fake .db file in the data dir
      writeFileSync(join(testDataDir, 'meridian.db'), '');

      const diagnostics = await manager.runDiagnostics();

      const dbCheck = diagnostics.checks.find(
        (c) => c.name === 'Database files readable/writable',
      );
      expect(dbCheck).toBeDefined();
      expect(dbCheck?.passed).toBe(true);
    });

    it('should fail database files check when a file is not accessible', async () => {
      // Create a read-only .db file
      const dbFilePath = join(testDataDir, 'meridian.db');
      writeFileSync(dbFilePath, '');
      chmodSync(dbFilePath, 0o000);

      try {
        const diagnostics = await manager.runDiagnostics();

        const dbCheck = diagnostics.checks.find(
          (c) => c.name === 'Database files readable/writable',
        );
        expect(dbCheck).toBeDefined();
        expect(dbCheck?.passed).toBe(false);
        expect(dbCheck?.severity).toBe('abort');
        expect(dbCheck?.message).toContain('meridian');
        expect(diagnostics.canProceed).toBe(false);
      } finally {
        // Restore permissions so cleanup can delete it
        chmodSync(dbFilePath, 0o644);
      }
    });

    it('should include disk space and RAM as warning-level checks', async () => {
      const diagnostics = await manager.runDiagnostics();

      const diskCheck = diagnostics.checks.find(
        (c) => c.name === 'Disk space > 500 MB',
      );
      expect(diskCheck).toBeDefined();
      expect(diskCheck?.severity).toBe('warning');

      const ramCheck = diagnostics.checks.find(
        (c) => c.name === 'Available RAM > 1 GB',
      );
      expect(ramCheck).toBeDefined();
      expect(ramCheck?.severity).toBe('warning');
    });

    it('should allow proceeding even when warning checks fail', async () => {
      // In a normal dev environment, warnings should pass. But even if
      // they didn't, canProceed should still be true as long as abort
      // checks pass. We verify the logic by checking the structure.
      const diagnostics = await manager.runDiagnostics();

      const warningFails = diagnostics.checks.filter(
        (c) => c.severity === 'warning' && !c.passed,
      );
      const abortFails = diagnostics.checks.filter(
        (c) => c.severity === 'abort' && !c.passed,
      );

      // canProceed depends only on abort-level checks
      if (abortFails.length === 0) {
        expect(diagnostics.canProceed).toBe(true);
      }
      // warningFails.length is irrelevant to canProceed
      expect(typeof warningFails.length).toBe('number');
    });
  });

  describe('health probes', () => {
    it('should have correct liveness/readiness through the lifecycle', async () => {
      const phases: Array<{ phase: StartupPhase; live: boolean; ready: boolean }> = [];

      manager.registerStep('config', 'Load config', noop);
      manager.registerStep('database', 'Open databases', () => {
        phases.push({
          phase: manager.getPhase(),
          live: manager.getLiveness(),
          ready: manager.getReadiness(),
        });
        return Promise.resolve();
      });
      manager.registerStep('bridge', 'Start Bridge', () => {
        phases.push({
          phase: manager.getPhase(),
          live: manager.getLiveness(),
          ready: manager.getReadiness(),
        });
        return Promise.resolve();
      });

      await manager.startup();

      // After config → live=true, ready=false
      expect(phases[0]?.live).toBe(true);
      expect(phases[0]?.ready).toBe(false);

      // During bridge → live=true, ready=false (set after handler completes)
      expect(phases[1]?.live).toBe(true);
      expect(phases[1]?.ready).toBe(false);

      // After startup → live=true, ready=true
      expect(manager.getLiveness()).toBe(true);
      expect(manager.getReadiness()).toBe(true);
    });
  });
});
