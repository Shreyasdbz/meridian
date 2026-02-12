// @meridian/shared — Async database client (Section 11.1)
//
// Wraps SQLite operations with an async API. Supports two modes:
// 1. Worker mode (production): delegates to a worker_threads worker
// 2. Direct mode (testing/development): uses DatabaseEngine in-process
//
// All packages use this client — no package opens its own database connections.

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { generateId } from '../id.js';

import { DatabaseEngine } from './engine.js';
import type { DatabaseName, DeploymentTier, RunResult, WorkerResponse } from './types.js';

// ---------------------------------------------------------------------------
// Transaction context (AsyncLocalStorage)
// ---------------------------------------------------------------------------

interface TransactionContext {
  dbName: string;
}

const transactionStorage = new AsyncLocalStorage<TransactionContext>();

// ---------------------------------------------------------------------------
// Write mutex — serializes write operations per database
// ---------------------------------------------------------------------------

class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolveAcquire) => {
      this.queue.push(resolveAcquire);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Database client options
// ---------------------------------------------------------------------------

export interface DatabaseClientOptions {
  /** Base directory for database files. Default: './data' */
  dataDir?: string;
  /** Deployment tier for PRAGMA tuning. Default: 'desktop' */
  tier?: DeploymentTier;
  /**
   * Run SQLite operations directly in-process instead of a worker thread.
   * Use for testing. In production, always use worker mode (the default)
   * to keep SQLite operations off the main event loop (Section 11.1).
   */
  direct?: boolean;
}

// ---------------------------------------------------------------------------
// Database client
// ---------------------------------------------------------------------------

export class DatabaseClient {
  // Worker mode state
  private worker: Worker | null = null;
  private pending = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  // Direct mode state
  private engine: DatabaseEngine | null = null;

  // Shared state
  private writeMutexes = new Map<string, Mutex>();
  private initialized = new Set<string>();
  private dataDir: string;
  private tier: DeploymentTier;
  private direct: boolean;
  private closed = false;
  private started = false;

  constructor(options: DatabaseClientOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? './data');
    this.tier = options.tier ?? 'desktop';
    this.direct = options.direct ?? false;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the database client. Must be called before any database operations.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.closed = false;

    if (this.direct) {
      this.engine = new DatabaseEngine();
      this.started = true;
      return;
    }

    // Worker mode
    const { workerPath, workerOptions } = this.resolveWorkerConfig();
    const worker = new Worker(workerPath, workerOptions);
    this.worker = worker;

    // Wait for the worker to signal readiness
    await new Promise<void>((resolveReady, rejectReady) => {
      const onMessage = (msg: WorkerResponse): void => {
        if (msg.id === '__ready__') {
          worker.off('message', onMessage);
          worker.off('error', onError);
          resolveReady();
        }
      };
      const onError = (err: Error): void => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        rejectReady(err);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
    });

    // Route all subsequent messages through the pending map
    worker.on('message', (msg: WorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);

      if (msg.type === 'error') {
        const err = new Error(msg.error ?? 'Unknown database error');
        if (msg.code) {
          (err as Error & { code: string }).code = msg.code;
        }
        entry.reject(err);
      } else {
        entry.resolve(msg.data);
      }
    });

    worker.on('error', (err: Error) => {
      for (const [, entry] of this.pending) {
        entry.reject(err);
      }
      this.pending.clear();
    });

    this.started = true;
  }

  /**
   * Close all database connections and terminate the worker thread (if any).
   */
  async close(): Promise<void> {
    if (!this.started || this.closed) {
      return;
    }
    this.closed = true;

    if (this.direct) {
      this.engine?.close();
      this.engine = null;
    } else if (this.worker) {
      try {
        await this.sendWorker({ type: 'close', id: generateId() });
      } catch {
        // Best-effort close
      }
      await this.worker.terminate();
      this.worker = null;
      this.pending.clear();
    }

    this.initialized.clear();
    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Database initialization
  // -------------------------------------------------------------------------

  /**
   * Ensure a database is opened and configured. Called automatically
   * on first access, but can be called explicitly for eager initialization.
   *
   * @param db - The logical database name
   * @param dbPath - Override the database file path (useful for audit-YYYY-MM.db)
   */
  async open(db: DatabaseName, dbPath?: string): Promise<void> {
    const resolvedPath = dbPath ?? this.defaultPath(db);
    const key = this.dbKey(db, resolvedPath);

    if (this.initialized.has(key)) {
      return;
    }

    // Ensure the data directory exists
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (this.direct) {
      this.getEngine().open(key, resolvedPath, this.tier);
    } else {
      await this.sendWorker({
        type: 'init',
        id: generateId(),
        dbName: key,
        dbPath: resolvedPath,
        tier: this.tier,
      });
    }

    this.initialized.add(key);
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  /**
   * Execute a read query and return all matching rows.
   * Uses the readonly connection unless inside a transaction.
   */
  async query<T>(db: DatabaseName, sql: string, params?: unknown[]): Promise<T[]> {
    const key = await this.ensureOpen(db);
    const txCtx = transactionStorage.getStore();
    const useWriteConnection = txCtx?.dbName === key;

    if (this.direct) {
      return this.getEngine().query(key, sql, params, useWriteConnection) as T[];
    }

    const data = await this.sendWorker({
      type: 'query',
      id: generateId(),
      dbName: key,
      sql,
      params,
      useWriteConnection,
    });
    return data as T[];
  }

  /**
   * Execute a write statement (INSERT, UPDATE, DELETE).
   * Serialized per database via write mutex.
   */
  async run(db: DatabaseName, sql: string, params?: unknown[]): Promise<RunResult> {
    const key = await this.ensureOpen(db);
    const txCtx = transactionStorage.getStore();

    // If inside a transaction for this database, skip the mutex (already held)
    if (txCtx?.dbName === key) {
      return this.executeRun(key, sql, params);
    }

    const mutex = this.getMutex(key);
    await mutex.acquire();
    try {
      return await this.executeRun(key, sql, params);
    } finally {
      mutex.release();
    }
  }

  /**
   * Execute raw SQL (DDL statements, multi-statement scripts).
   * Used primarily by the migrator. Acquires the write mutex.
   */
  async exec(db: DatabaseName, sql: string): Promise<void> {
    const key = await this.ensureOpen(db);
    const txCtx = transactionStorage.getStore();

    if (txCtx?.dbName === key) {
      return this.executeExec(key, sql);
    }

    const mutex = this.getMutex(key);
    await mutex.acquire();
    try {
      await this.executeExec(key, sql);
    } finally {
      mutex.release();
    }
  }

  /**
   * Run a function inside a database transaction.
   * All query() and run() calls within fn() are part of the same transaction.
   * Reads inside the transaction use the write connection to see uncommitted writes.
   */
  async transaction<T>(db: DatabaseName, fn: () => Promise<T>): Promise<T> {
    const key = await this.ensureOpen(db);
    const mutex = this.getMutex(key);
    await mutex.acquire();

    try {
      await this.executeBegin(key);

      try {
        const result = await transactionStorage.run({ dbName: key }, fn);
        await this.executeCommit(key);
        return result;
      } catch (error) {
        try {
          await this.executeRollback(key);
        } catch {
          // Rollback best-effort — the original error is more important
        }
        throw error;
      }
    } finally {
      mutex.release();
    }
  }

  /**
   * Create a backup of a database via VACUUM INTO.
   */
  async backup(db: DatabaseName, destPath: string): Promise<void> {
    const key = await this.ensureOpen(db);

    if (this.direct) {
      this.getEngine().backup(key, destPath);
      return;
    }

    await this.sendWorker({
      type: 'backup',
      id: generateId(),
      dbName: key,
      destPath,
    });
  }

  // -------------------------------------------------------------------------
  // Internals — execution helpers
  // -------------------------------------------------------------------------

  private async executeRun(key: string, sql: string, params?: unknown[]): Promise<RunResult> {
    if (this.direct) {
      return this.getEngine().run(key, sql, params);
    }
    const data = await this.sendWorker({
      type: 'run',
      id: generateId(),
      dbName: key,
      sql,
      params,
    });
    return data as RunResult;
  }

  private async executeExec(key: string, sql: string): Promise<void> {
    if (this.direct) {
      this.getEngine().exec(key, sql);
      return;
    }
    await this.sendWorker({ type: 'exec', id: generateId(), dbName: key, sql });
  }

  private async executeBegin(key: string): Promise<void> {
    if (this.direct) {
      this.getEngine().begin(key);
      return;
    }
    await this.sendWorker({ type: 'begin', id: generateId(), dbName: key });
  }

  private async executeCommit(key: string): Promise<void> {
    if (this.direct) {
      this.getEngine().commit(key);
      return;
    }
    await this.sendWorker({ type: 'commit', id: generateId(), dbName: key });
  }

  private async executeRollback(key: string): Promise<void> {
    if (this.direct) {
      this.getEngine().rollback(key);
      return;
    }
    await this.sendWorker({ type: 'rollback', id: generateId(), dbName: key });
  }

  // -------------------------------------------------------------------------
  // Internals — path and state management
  // -------------------------------------------------------------------------

  /**
   * Resolve the worker path and options. In production (built JS), loads worker.js
   * directly. In development (TypeScript source), loads worker.ts via tsx.
   */
  private resolveWorkerConfig(): {
    workerPath: string;
    workerOptions: ConstructorParameters<typeof Worker>[1];
  } {
    const dir = dirname(fileURLToPath(import.meta.url));
    const jsPath = resolve(dir, 'worker.js');
    const tsPath = resolve(dir, 'worker.ts');

    if (existsSync(jsPath)) {
      return { workerPath: jsPath, workerOptions: {} };
    }

    // Development: load TypeScript worker via tsx
    return {
      workerPath: tsPath,
      workerOptions: {
        execArgv: ['--import', 'tsx'],
      },
    };
  }

  private getEngine(): DatabaseEngine {
    if (!this.engine) {
      throw new Error('DatabaseEngine is not initialized.');
    }
    return this.engine;
  }

  private getWorker(): Worker {
    if (!this.worker) {
      throw new Error('Worker is not running.');
    }
    return this.worker;
  }

  private defaultPath(db: DatabaseName): string {
    return resolve(this.dataDir, `${db}.db`);
  }

  private dbKey(db: DatabaseName, dbPath: string): string {
    if (db === 'audit' && dbPath !== this.defaultPath(db)) {
      return basename(dbPath, '.db') || db;
    }
    return db;
  }

  private async ensureOpen(db: DatabaseName): Promise<string> {
    this.assertStarted();
    const path = this.defaultPath(db);
    const key = this.dbKey(db, path);
    if (!this.initialized.has(key)) {
      await this.open(db);
    }
    return key;
  }

  private getMutex(key: string): Mutex {
    let mutex = this.writeMutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.writeMutexes.set(key, mutex);
    }
    return mutex;
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('DatabaseClient is not started. Call start() first.');
    }
    if (this.closed) {
      throw new Error('DatabaseClient is closed.');
    }
  }

  // -------------------------------------------------------------------------
  // Internals — worker communication
  // -------------------------------------------------------------------------

  private sendWorker(msg: { id: string; type: string; [key: string]: unknown }): Promise<unknown> {
    const worker = this.getWorker();

    return new Promise((resolveMsg, rejectMsg) => {
      this.pending.set(msg.id, { resolve: resolveMsg, reject: rejectMsg });
      worker.postMessage(msg);
    });
  }
}
