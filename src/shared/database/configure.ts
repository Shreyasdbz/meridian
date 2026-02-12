// @meridian/shared — SQLite PRAGMA configuration (Section 8.2.1)

import type Database from 'better-sqlite3';

import type { DeploymentTier } from './types.js';

/**
 * Cache size and mmap_size settings per deployment tier (Section 8.2.1).
 *
 * | Tier       | cache_size        | mmap_size               |
 * |------------|-------------------|-------------------------|
 * | desktop    | -20000 (~20 MB)   | 268435456 (256 MB)      |
 * | vps        | -20000 (~20 MB)   | 268435456 (256 MB)      |
 * | pi         | -8000  (~8 MB)    | 67108864  (64 MB)       |
 */
const TIER_PRAGMAS: Record<DeploymentTier, { cacheSize: number; mmapSize: number }> = {
  desktop: { cacheSize: -20000, mmapSize: 268435456 },
  vps: { cacheSize: -20000, mmapSize: 268435456 },
  pi: { cacheSize: -8000, mmapSize: 67108864 },
};

/**
 * Configure a SQLite connection with required PRAGMAs.
 *
 * Every database connection must call this at open time. The PRAGMAs ensure:
 * - WAL mode for concurrent reads
 * - Appropriate synchronous level (FULL for audit, NORMAL otherwise)
 * - 5-second busy timeout instead of immediate failure
 * - Foreign key enforcement (OFF by default in SQLite)
 * - Incremental auto-vacuum
 * - In-memory temp storage
 * - Tier-appropriate cache and mmap sizes
 *
 * @param db - The better-sqlite3 database instance
 * @param tier - Deployment tier for tuning
 * @param isAudit - Whether this is an audit database (uses synchronous = FULL)
 */
export function configureConnection(
  db: Database.Database,
  tier: DeploymentTier,
  isAudit: boolean = false,
): void {
  const tierPragmas = TIER_PRAGMAS[tier];

  // Core PRAGMAs — order matters: journal_mode and auto_vacuum must be set early
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${isAudit ? 'FULL' : 'NORMAL'}`);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('temp_store = MEMORY');

  // Tier-specific tuning
  db.pragma(`cache_size = ${tierPragmas.cacheSize}`);
  db.pragma(`mmap_size = ${tierPragmas.mmapSize}`);
}
