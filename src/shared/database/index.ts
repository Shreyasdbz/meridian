// @meridian/shared/database — Public API

// Types
export type {
  DatabaseName,
  DeploymentTier,
  RunResult,
  WorkerRequest,
  WorkerResponse,
} from './types.js';

// Client
export { DatabaseClient } from './client.js';
export type { DatabaseClientOptions } from './client.js';

// Configuration
export { configureConnection } from './configure.js';

// Migrator
export { discoverMigrations, getCurrentVersion, migrate, migrateAll } from './migrator.js';
export type { MigrationFile, MigrationResult } from './migrator.js';
