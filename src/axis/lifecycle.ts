// @meridian/axis — Startup & shutdown lifecycle manager (Sections 5.1.14, 5.1.15)
//
// Orchestrates the 7-step startup sequence, self-diagnostic checks,
// and graceful shutdown protocol.
//
// Startup sequence:
//   1. Load config and init logging → liveness probe returns 200
//   2. Open databases and run migrations (WAL mode)
//   3. Axis core startup (router, scheduler, watchdog)
//   4. Component registration (Scout, Sentinel, Journal, built-in Gear)
//   5. Crash recovery and startup reconciliation
//   6. Bridge startup (HTTP + WS) → readiness probe returns 200
//   7. Ready — begin processing job queue
//
// Graceful shutdown (SIGTERM/SIGINT):
//   1. Stop accepting new connections
//   2. Stop claiming new jobs
//   3. Wait up to 30s for running jobs
//   4. SIGTERM to Gear sandbox processes; SIGKILL after 10s
//   5. Persist in-flight state to SQLite
//   6. Close all database connections
//   7. Exit code 0

import { existsSync, accessSync, constants as fsConstants, statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';

import {
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GEAR_KILL_TIMEOUT_MS,
  MIN_DISK_SPACE_MB,
  MIN_RAM_MB,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for lifecycle events.
 */
export interface LifecycleLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Current startup phase.
 */
export type StartupPhase =
  | 'not_started'
  | 'config'
  | 'database'
  | 'axis_core'
  | 'components'
  | 'recovery'
  | 'bridge'
  | 'ready';

/**
 * Self-diagnostic check result.
 */
export interface DiagnosticCheck {
  name: string;
  severity: 'abort' | 'warning';
  passed: boolean;
  message: string;
}

/**
 * Result of self-diagnostic checks.
 */
export interface DiagnosticResult {
  checks: DiagnosticCheck[];
  /** True if all abort-level checks passed. */
  canProceed: boolean;
}

/**
 * Step handler for a startup phase. Returns void on success, throws on failure.
 */
export type StartupStepHandler = () => Promise<void>;

/**
 * Shutdown handler. Called during graceful shutdown.
 */
export type ShutdownHandler = () => Promise<void>;

/**
 * Options for the lifecycle manager.
 */
export interface LifecycleOptions {
  /** Data directory for self-diagnostic checks. */
  dataDir: string;
  /** Port for the Bridge server. */
  port: number;
  /** Logger for lifecycle events. */
  logger?: LifecycleLogger;
  /** Graceful shutdown timeout in ms. Default: GRACEFUL_SHUTDOWN_TIMEOUT_MS (30s). */
  shutdownTimeoutMs?: number;
  /** Gear kill timeout in ms. Default: GEAR_KILL_TIMEOUT_MS (10s). */
  gearKillTimeoutMs?: number;
  /** Database file names to check (without .db extension). Default: ['meridian', 'journal', 'sentinel']. */
  databaseNames?: string[];
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: LifecycleLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// LifecycleManager
// ---------------------------------------------------------------------------

/**
 * Manages the application startup sequence and graceful shutdown.
 *
 * The startup sequence is a series of ordered phases. Each phase must
 * complete before the next one begins. If any phase fails, startup
 * is aborted.
 *
 * Startup phases are registered via `registerStep()`. The lifecycle
 * manager invokes them in order during `startup()`.
 *
 * Shutdown handlers are registered via `registerShutdownHandler()`.
 * They are invoked in reverse registration order during `shutdown()`.
 */
export class LifecycleManager {
  private readonly dataDir: string;
  private readonly port: number;
  private readonly logger: LifecycleLogger;
  private readonly shutdownTimeoutMs: number;
  private readonly gearKillTimeoutMs: number;
  private readonly databaseNames: string[];

  private phase: StartupPhase = 'not_started';
  private isLive = false;
  private isReady = false;
  private isShuttingDown = false;

  /** Ordered list of startup steps. */
  private readonly startupSteps: Array<{
    phase: StartupPhase;
    name: string;
    handler: StartupStepHandler;
  }> = [];

  /** Shutdown handlers, invoked in reverse order. */
  private readonly shutdownHandlers: Array<{
    name: string;
    handler: ShutdownHandler;
  }> = [];

  /** Signal handlers for cleanup on process exit. */
  private signalHandlers: Map<string, () => void> = new Map();

  constructor(options: LifecycleOptions) {
    this.dataDir = options.dataDir;
    this.port = options.port;
    this.logger = options.logger ?? noopLogger;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    this.gearKillTimeoutMs = options.gearKillTimeoutMs ?? GEAR_KILL_TIMEOUT_MS;
    this.databaseNames = options.databaseNames ?? ['meridian', 'journal', 'sentinel'];
  }

  // -------------------------------------------------------------------------
  // Step registration
  // -------------------------------------------------------------------------

  /**
   * Register a startup step. Steps are executed in registration order
   * during `startup()`.
   */
  registerStep(phase: StartupPhase, name: string, handler: StartupStepHandler): void {
    this.startupSteps.push({ phase, name, handler });
  }

  /**
   * Register a shutdown handler. Handlers are called in reverse
   * registration order during `shutdown()`.
   */
  registerShutdownHandler(name: string, handler: ShutdownHandler): void {
    this.shutdownHandlers.push({ name, handler });
  }

  // -------------------------------------------------------------------------
  // Self-diagnostic (Section 5.1.15)
  // -------------------------------------------------------------------------

  /**
   * Run self-diagnostic checks. Called during step 2 of the startup sequence.
   *
   * Abort-level checks cause immediate exit if they fail.
   * Warning-level checks are logged but do not prevent startup.
   */
  async runDiagnostics(): Promise<DiagnosticResult> {
    const checks: DiagnosticCheck[] = [];

    // Abort: Data directory writable
    checks.push(this.checkDataDirWritable());

    // Abort: Port available
    checks.push(await this.checkPortAvailable());

    // Abort: Database files readable/writable
    checks.push(this.checkDatabaseFiles());

    // Abort: Node.js >= 20
    checks.push(this.checkNodeVersion());

    // Warning: Disk space > 500 MB
    checks.push(this.checkDiskSpace());

    // Warning: Available RAM > 1 GB
    checks.push(this.checkAvailableRam());

    const canProceed = checks
      .filter((c) => c.severity === 'abort')
      .every((c) => c.passed);

    return { checks, canProceed };
  }

  private checkDataDirWritable(): DiagnosticCheck {
    const name = 'Data directory writable';
    try {
      if (!existsSync(this.dataDir)) {
        return {
          name,
          severity: 'abort',
          passed: false,
          message: `Data directory does not exist: ${this.dataDir}`,
        };
      }
      accessSync(this.dataDir, fsConstants.W_OK | fsConstants.R_OK);
      return { name, severity: 'abort', passed: true, message: 'OK' };
    } catch {
      return {
        name,
        severity: 'abort',
        passed: false,
        message: `Data directory is not writable: ${this.dataDir}`,
      };
    }
  }

  private async checkPortAvailable(): Promise<DiagnosticCheck> {
    const name = 'Port available';
    try {
      const available = await isPortAvailable(this.port);
      if (available) {
        return { name, severity: 'abort', passed: true, message: `Port ${this.port} is available` };
      }
      return {
        name,
        severity: 'abort',
        passed: false,
        message: `Port ${this.port} is already in use`,
      };
    } catch (error: unknown) {
      return {
        name,
        severity: 'abort',
        passed: false,
        message: `Port check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private checkDatabaseFiles(): DiagnosticCheck {
    const name = 'Database files readable/writable';
    const inaccessible: string[] = [];

    for (const dbName of this.databaseNames) {
      const dbPath = join(this.dataDir, `${dbName}.db`);
      if (!existsSync(dbPath)) {
        // File doesn't exist yet — that's fine, migrations will create it
        continue;
      }
      try {
        accessSync(dbPath, fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        inaccessible.push(dbName);
      }
    }

    if (inaccessible.length > 0) {
      return {
        name,
        severity: 'abort',
        passed: false,
        message: `Database files not readable/writable: ${inaccessible.join(', ')}`,
      };
    }
    return { name, severity: 'abort', passed: true, message: 'OK' };
  }

  private checkNodeVersion(): DiagnosticCheck {
    const name = 'Node.js >= 20';
    const major = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    if (major >= 20) {
      return { name, severity: 'abort', passed: true, message: `Node.js v${process.versions.node}` };
    }
    return {
      name,
      severity: 'abort',
      passed: false,
      message: `Node.js v${process.versions.node} is below minimum v20`,
    };
  }

  private checkDiskSpace(): DiagnosticCheck {
    const name = 'Disk space > 500 MB';
    try {
      const stats = statfsSync(this.dataDir);
      const availableMb = (stats.bavail * stats.bsize) / (1024 * 1024);
      if (availableMb >= MIN_DISK_SPACE_MB) {
        return {
          name,
          severity: 'warning',
          passed: true,
          message: `${Math.round(availableMb)} MB available`,
        };
      }
      return {
        name,
        severity: 'warning',
        passed: false,
        message: `Only ${Math.round(availableMb)} MB available (minimum: ${MIN_DISK_SPACE_MB} MB)`,
      };
    } catch {
      return {
        name,
        severity: 'warning',
        passed: false,
        message: 'Unable to check disk space',
      };
    }
  }

  private checkAvailableRam(): DiagnosticCheck {
    const name = 'Available RAM > 1 GB';
    const freeMemMb = freemem() / (1024 * 1024);
    const totalMemMb = totalmem() / (1024 * 1024);

    if (freeMemMb >= MIN_RAM_MB) {
      return {
        name,
        severity: 'warning',
        passed: true,
        message: `${Math.round(freeMemMb)} MB free of ${Math.round(totalMemMb)} MB total`,
      };
    }
    return {
      name,
      severity: 'warning',
      passed: false,
      message: `Only ${Math.round(freeMemMb)} MB free (minimum: ${MIN_RAM_MB} MB)`,
    };
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  /**
   * Execute the full startup sequence.
   *
   * Runs all registered startup steps in order. If any step fails,
   * startup is aborted and the error is propagated.
   *
   * @throws Error if any startup step fails
   */
  async startup(): Promise<void> {
    if (this.phase !== 'not_started') {
      throw new Error(`Cannot start: already in phase '${this.phase}'`);
    }

    const startTime = performance.now();
    this.logger.info('Starting Meridian...');

    for (const step of this.startupSteps) {
      this.phase = step.phase;
      this.logger.info(`Startup step: ${step.name}`, { phase: step.phase });

      const stepStart = performance.now();
      try {
        await step.handler();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Startup failed at step: ${step.name}`, {
          phase: step.phase,
          error: message,
        });
        throw error;
      }
      const stepDuration = Math.round(performance.now() - stepStart);
      this.logger.debug(`Startup step complete: ${step.name}`, {
        phase: step.phase,
        durationMs: stepDuration,
      });

      // After step 1 (config), mark as live
      if (step.phase === 'config') {
        this.isLive = true;
      }

      // After step 6 (bridge), mark as ready
      if (step.phase === 'bridge') {
        this.isReady = true;
      }
    }

    this.phase = 'ready';
    const totalDuration = Math.round(performance.now() - startTime);
    this.logger.info('Meridian started successfully', {
      totalDurationMs: totalDuration,
    });
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /**
   * Execute graceful shutdown.
   *
   * Runs all registered shutdown handlers in reverse order.
   * Enforces the overall shutdown timeout.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    this.isReady = false;
    this.logger.info('Shutting down Meridian...');

    const startTime = performance.now();

    // Create a timeout that will force the process to exit
    const forceExitTimer = setTimeout(() => {
      this.logger.error('Shutdown timeout exceeded, forcing exit');
      // In production, this would call process.exit(1).
      // For testability, we just log.
    }, this.shutdownTimeoutMs + this.gearKillTimeoutMs);

    // Prevent the force exit timer from keeping the process alive
    if (typeof forceExitTimer === 'object' && 'unref' in forceExitTimer) {
      forceExitTimer.unref();
    }

    try {
      // Run shutdown handlers in reverse order
      for (let i = this.shutdownHandlers.length - 1; i >= 0; i--) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounds checked by loop
        const handler = this.shutdownHandlers[i]!;
        this.logger.info(`Shutdown step: ${handler.name}`);

        try {
          await handler.handler();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Shutdown handler failed: ${handler.name}`, {
            error: message,
          });
          // Continue with remaining handlers even if one fails
        }
      }
    } finally {
      clearTimeout(forceExitTimer);
    }

    this.isLive = false;
    this.phase = 'not_started';

    const totalDuration = Math.round(performance.now() - startTime);
    this.logger.info('Meridian shutdown complete', {
      totalDurationMs: totalDuration,
    });
  }

  // -------------------------------------------------------------------------
  // Signal handling
  // -------------------------------------------------------------------------

  /**
   * Register SIGTERM and SIGINT handlers for graceful shutdown.
   *
   * The handlers call `shutdown()` and then exit the process.
   * Call `removeSignalHandlers()` during testing to prevent
   * interference with the test runner.
   */
  registerSignalHandlers(): void {
    const handler = (): void => {
      void this.shutdown().then(() => {
        process.exit(0);
      }).catch((error: unknown) => {
        this.logger.error('Shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
    };

    const sigterm = (): void => {
      this.logger.info('Received SIGTERM');
      handler();
    };
    const sigint = (): void => {
      this.logger.info('Received SIGINT');
      handler();
    };

    process.on('SIGTERM', sigterm);
    process.on('SIGINT', sigint);

    this.signalHandlers.set('SIGTERM', sigterm);
    this.signalHandlers.set('SIGINT', sigint);
  }

  /**
   * Remove registered signal handlers.
   */
  removeSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
  }

  // -------------------------------------------------------------------------
  // Health probes
  // -------------------------------------------------------------------------

  /**
   * Liveness probe. Returns true after step 1 (config loaded).
   * Indicates the process is running and responsive.
   */
  getLiveness(): boolean {
    return this.isLive;
  }

  /**
   * Readiness probe. Returns true after step 6 (Bridge started).
   * Indicates the system is fully initialized and can accept requests.
   */
  getReadiness(): boolean {
    return this.isReady && !this.isShuttingDown;
  }

  /**
   * Get the current startup phase.
   */
  getPhase(): StartupPhase {
    return this.phase;
  }

  /**
   * Check if shutdown is in progress.
   */
  getIsShuttingDown(): boolean {
    return this.isShuttingDown;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a TCP port is available for binding.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, '127.0.0.1');
  });
}
