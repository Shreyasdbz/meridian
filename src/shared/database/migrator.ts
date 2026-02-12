// @meridian/shared — Migration framework (Section 8.5)
//
// Reads numbered SQL files from module migration directories, tracks schema
// versions per database, and applies pending migrations on startup.
// Forward-only — pre-migration backups serve as the rollback mechanism.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DatabaseClient } from './client.js';
import type { DatabaseName } from './types.js';

/**
 * Base database names (excludes monthly audit partitions like 'audit-2026-02').
 */
type BaseDatabaseName = 'meridian' | 'journal' | 'sentinel' | 'audit';

/**
 * Mapping of base database names to their migration directories.
 * Paths are relative to the project root.
 * Audit partitions (audit-YYYY-MM) share the 'audit' migration directory.
 */
const DEFAULT_MIGRATION_DIRS: Record<BaseDatabaseName, string> = {
  meridian: 'src/axis/migrations',
  journal: 'src/journal/migrations',
  sentinel: 'src/sentinel/migrations',
  audit: 'src/shared/database/migrations/audit',
};

export interface MigrationFile {
  version: number;
  name: string;
  path: string;
  sql: string;
}

export interface MigrationResult {
  database: DatabaseName;
  applied: number[];
  currentVersion: number;
}

/**
 * Discover migration files for a database.
 * Files must be named NNN_description.sql (e.g., 001_initial.sql).
 */
export function discoverMigrations(
  db: DatabaseName,
  projectRoot: string,
  migrationDirs?: Partial<Record<BaseDatabaseName, string>>,
): MigrationFile[] {
  const dirs = { ...DEFAULT_MIGRATION_DIRS, ...migrationDirs };
  // Audit partitions (audit-YYYY-MM) share the 'audit' migration directory
  const baseDb: BaseDatabaseName = db.startsWith('audit') ? 'audit' : db as BaseDatabaseName;
  const dir = resolve(projectRoot, dirs[baseDb]);

  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();

  return files.map((file) => {
    const version = parseInt(file.slice(0, 3), 10);
    const filePath = resolve(dir, file);
    return {
      version,
      name: file,
      path: filePath,
      sql: readFileSync(filePath, 'utf-8'),
    };
  });
}

/**
 * Ensure the schema_version table exists in the database.
 */
async function ensureVersionTable(client: DatabaseClient, db: DatabaseName): Promise<void> {
  await client.exec(
    db,
    `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  );
}

/**
 * Get the current schema version for a database.
 */
export async function getCurrentVersion(client: DatabaseClient, db: DatabaseName): Promise<number> {
  await ensureVersionTable(client, db);

  const rows = await client.query<{ version: number }>(
    db,
    'SELECT MAX(version) as version FROM schema_version',
  );

  return rows[0]?.version ?? 0;
}

/**
 * Run all pending migrations for a database.
 *
 * Each migration runs in its own transaction. If a migration fails,
 * it rolls back and aborts with a clear error.
 *
 * @param client - The database client
 * @param db - The database to migrate
 * @param projectRoot - The project root directory (for resolving migration files)
 * @param options - Optional configuration
 * @returns Migration result with applied versions
 */
export async function migrate(
  client: DatabaseClient,
  db: DatabaseName,
  projectRoot: string,
  options?: {
    migrationDirs?: Partial<Record<BaseDatabaseName, string>>;
    backupDir?: string;
  },
): Promise<MigrationResult> {
  const migrations = discoverMigrations(db, projectRoot, options?.migrationDirs);
  const currentVersion = await getCurrentVersion(client, db);

  const pending = migrations.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return { database: db, applied: [], currentVersion };
  }

  // Pre-migration backup via VACUUM INTO (Section 8.5)
  if (currentVersion > 0 && options?.backupDir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = resolve(options.backupDir, `${db}-pre-migration-${timestamp}.db`);
    await client.backup(db, backupPath);
  }

  const applied: number[] = [];

  for (const migration of pending) {
    try {
      await client.transaction(db, async () => {
        // Execute the migration SQL
        await client.exec(db, migration.sql);

        // Record the migration
        await client.run(db, 'INSERT INTO schema_version (version, name) VALUES (?, ?)', [
          migration.version,
          migration.name,
        ]);
      });
      applied.push(migration.version);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.name} failed for ${db}: ${msg}`, { cause: error });
    }
  }

  const lastApplied = applied[applied.length - 1];
  const newVersion = lastApplied !== undefined ? lastApplied : currentVersion;

  return {
    database: db,
    applied,
    currentVersion: newVersion,
  };
}

/**
 * Run migrations for all databases.
 * Used at application startup to ensure all schemas are up to date.
 */
export async function migrateAll(
  client: DatabaseClient,
  projectRoot: string,
  options?: {
    migrationDirs?: Partial<Record<BaseDatabaseName, string>>;
    backupDir?: string;
    databases?: DatabaseName[];
  },
): Promise<MigrationResult[]> {
  const databases = options?.databases ?? (['meridian', 'journal', 'sentinel', 'audit'] as const);
  const results: MigrationResult[] = [];

  for (const db of databases) {
    const result = await migrate(client, db, projectRoot, options);
    results.push(result);
  }

  return results;
}
