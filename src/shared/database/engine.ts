// @meridian/shared — Core database engine (synchronous operations)
//
// Extracted from the worker thread to enable both:
// 1. Worker thread mode (production): engine runs in a dedicated thread
// 2. Direct mode (testing): engine runs in the main thread
//
// All operations are synchronous — when used via worker thread, this is fine
// because the worker has no other work. When used directly, callers should
// be aware of the blocking nature.

import Database from 'better-sqlite3';

import { configureConnection } from './configure.js';
import type { DeploymentTier, RunResult } from './types.js';

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

interface ConnectionPair {
  write: Database.Database;
  read: Database.Database;
  inTransaction: boolean;
}

export class DatabaseEngine {
  private connections = new Map<string, ConnectionPair>();

  /**
   * Open a database with write and readonly connections.
   */
  open(dbName: string, dbPath: string, tier: DeploymentTier): void {
    if (this.connections.has(dbName)) {
      return;
    }

    const isAudit = dbName === 'audit' || dbName.startsWith('audit-');

    const write = new Database(dbPath);
    configureConnection(write, tier, isAudit);

    const read = new Database(dbPath, { readonly: true });
    configureConnection(read, tier, isAudit);

    this.connections.set(dbName, { write, read, inTransaction: false });
  }

  /**
   * Execute a read query. Uses readonly connection unless useWriteConnection is true.
   */
  query(dbName: string, sql: string, params?: unknown[], useWriteConnection?: boolean): unknown[] {
    const conn = this.getConnection(dbName);
    const db = useWriteConnection ? conn.write : conn.read;
    const stmt = db.prepare(sql);
    return params ? stmt.all(...params) : stmt.all();
  }

  /**
   * Execute a write statement (INSERT, UPDATE, DELETE).
   */
  run(dbName: string, sql: string, params?: unknown[]): RunResult {
    const conn = this.getConnection(dbName);
    const stmt = conn.write.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  /**
   * Execute raw SQL (DDL, multi-statement scripts).
   */
  exec(dbName: string, sql: string): void {
    const conn = this.getConnection(dbName);
    conn.write.exec(sql);
  }

  /**
   * Begin a transaction on the write connection.
   */
  begin(dbName: string): void {
    const conn = this.getConnection(dbName);
    conn.write.exec('BEGIN');
    conn.inTransaction = true;
  }

  /**
   * Commit the current transaction.
   */
  commit(dbName: string): void {
    const conn = this.getConnection(dbName);
    conn.write.exec('COMMIT');
    conn.inTransaction = false;
  }

  /**
   * Rollback the current transaction.
   */
  rollback(dbName: string): void {
    const conn = this.getConnection(dbName);
    conn.write.exec('ROLLBACK');
    conn.inTransaction = false;
  }

  /**
   * Create a backup via VACUUM INTO.
   */
  backup(dbName: string, destPath: string): void {
    const conn = this.getConnection(dbName);
    // VACUUM INTO requires a string literal — parameterized binding is not supported.
    // Single quotes are escaped to prevent SQL injection via crafted paths.
    conn.write.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  }

  /**
   * Close a specific database or all databases.
   */
  close(dbName?: string): void {
    if (dbName) {
      this.closeOne(dbName);
    } else {
      for (const name of this.connections.keys()) {
        this.closeOne(name);
      }
    }
  }

  private getConnection(dbName: string): ConnectionPair {
    const conn = this.connections.get(dbName);
    if (!conn) {
      throw new Error(`Database '${dbName}' is not open. Call open() first.`);
    }
    return conn;
  }

  private closeOne(dbName: string): void {
    const conn = this.connections.get(dbName);
    if (conn) {
      if (conn.inTransaction) {
        try {
          conn.write.exec('ROLLBACK');
        } catch {
          // Ignore — might not be in a transaction
        }
      }
      conn.read.close();
      conn.write.close();
      this.connections.delete(dbName);
    }
  }
}
