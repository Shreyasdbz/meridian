// @meridian/gear — Gear registry: CRUD operations on the gear table (Section 5.6.2, 5.6.4)

import type { DatabaseClient, GearManifest, Result } from '@meridian/shared';
import {
  ok,
  NotFoundError,
  ConflictError,
  ValidationError,
} from '@meridian/shared';

import type { ManifestIssue } from './manifest.js';
import { validateManifest, computeChecksum } from './manifest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Filter options for listing Gear.
 */
export interface GearListFilter {
  /** Filter by origin: 'builtin' | 'user' | 'journal' */
  origin?: string;
  /** Filter by enabled state */
  enabled?: boolean;
  /** Filter by draft state */
  draft?: boolean;
}

/**
 * Row shape from the gear table in meridian.db.
 */
interface GearRow {
  id: string;
  name: string;
  version: string;
  manifest_json: string;
  origin: string;
  draft: number;
  installed_at: string;
  enabled: number;
  config_json: string | null;
  signature: string | null;
  checksum: string;
}

/**
 * Logger interface for registry operations.
 */
export interface RegistryLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Built-in Gear definition for auto-registration.
 */
export interface BuiltinGearDefinition {
  manifest: GearManifest;
  packagePath: string;
}

// ---------------------------------------------------------------------------
// Gear Registry
// ---------------------------------------------------------------------------

/**
 * Gear registry: CRUD operations on the gear table in meridian.db.
 *
 * Implements a `getManifest(gearId)` method that is structurally compatible
 * with the `GearLookup` interface in axis/plan-validator. The integration
 * wiring happens in Phase 5.7/8.1 — this module does not import from axis
 * to respect the module boundary (gear/ depends only on shared/).
 */
export class GearRegistry {
  private readonly db: DatabaseClient;
  private readonly logger: RegistryLogger;

  /** In-memory cache for fast GearLookup (plan validation) */
  private manifestCache = new Map<string, GearManifest>();

  constructor(db: DatabaseClient, logger: RegistryLogger) {
    this.db = db;
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // GearLookup interface (used by plan-validator)
  // -------------------------------------------------------------------------

  /**
   * Get a Gear manifest by ID. Returns undefined if not found or disabled.
   * This satisfies the GearLookup interface from plan-validator.
   */
  getManifest(gearId: string): GearManifest | undefined {
    return this.manifestCache.get(gearId);
  }

  // -------------------------------------------------------------------------
  // CRUD operations
  // -------------------------------------------------------------------------

  /**
   * Install a Gear into the registry.
   *
   * Validates the manifest, computes the checksum of the package, and stores
   * both in the gear table. Rejects duplicate IDs (use uninstall first).
   */
  async install(
    manifest: GearManifest,
    packagePath: string,
  ): Promise<Result<void, ManifestIssue[]>> {
    // Validate manifest structure
    const validationResult = validateManifest(manifest);
    if (!validationResult.ok) {
      return validationResult;
    }
    const validatedManifest = validationResult.value;

    // Check for duplicate
    const existing = await this.get(validatedManifest.id);
    if (existing) {
      throw new ConflictError(
        `Gear '${validatedManifest.id}' is already installed (version ${existing.version})`,
      );
    }

    // Compute checksum of the package
    const checksum = await computeChecksum(packagePath);

    // Store with the computed checksum
    const manifestToStore: GearManifest = {
      ...validatedManifest,
      checksum,
    };

    const now = new Date().toISOString();

    await this.db.run(
      'meridian',
      `INSERT INTO gear (id, name, version, manifest_json, origin, draft, installed_at, enabled, config_json, signature, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        manifestToStore.id,
        manifestToStore.name,
        manifestToStore.version,
        JSON.stringify(manifestToStore),
        manifestToStore.origin,
        manifestToStore.draft ? 1 : 0,
        now,
        1, // enabled by default
        null,
        manifestToStore.signature ?? null,
        checksum,
      ],
    );

    // Update cache
    this.manifestCache.set(manifestToStore.id, manifestToStore);

    this.logger.info('Gear installed', {
      gearId: manifestToStore.id,
      version: manifestToStore.version,
      origin: manifestToStore.origin,
    });

    return ok(undefined);
  }

  /**
   * Install a Gear from a pre-validated manifest without computing checksum
   * from a file. Used for built-in Gear auto-registration where the checksum
   * is already set in the manifest.
   */
  async installBuiltin(manifest: GearManifest): Promise<void> {
    // Validate manifest structure
    const validationResult = validateManifest(manifest);
    if (!validationResult.ok) {
      throw new ValidationError(
        `Built-in Gear '${manifest.id}' has invalid manifest: ${validationResult.error.map((i) => i.message).join('; ')}`,
      );
    }
    const validatedManifest = validationResult.value;

    const now = new Date().toISOString();

    await this.db.run(
      'meridian',
      `INSERT OR IGNORE INTO gear (id, name, version, manifest_json, origin, draft, installed_at, enabled, config_json, signature, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        validatedManifest.id,
        validatedManifest.name,
        validatedManifest.version,
        JSON.stringify(validatedManifest),
        'builtin',
        0,
        now,
        1,
        null,
        validatedManifest.signature ?? null,
        validatedManifest.checksum,
      ],
    );

    // Update cache
    this.manifestCache.set(validatedManifest.id, validatedManifest);

    this.logger.info('Built-in Gear registered', {
      gearId: validatedManifest.id,
      version: validatedManifest.version,
    });
  }

  /**
   * Uninstall a Gear from the registry.
   * Removes the gear table row and evicts from cache.
   */
  async uninstall(gearId: string): Promise<void> {
    const result = await this.db.run(
      'meridian',
      'DELETE FROM gear WHERE id = ?',
      [gearId],
    );

    if (result.changes === 0) {
      throw new NotFoundError(`Gear '${gearId}' not found`);
    }

    this.manifestCache.delete(gearId);

    this.logger.info('Gear uninstalled', { gearId });
  }

  /**
   * Get a Gear manifest by ID, or undefined if not found.
   */
  async get(gearId: string): Promise<GearManifest | undefined> {
    const rows = await this.db.query<GearRow>(
      'meridian',
      'SELECT * FROM gear WHERE id = ?',
      [gearId],
    );

    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return JSON.parse(row.manifest_json) as GearManifest;
  }

  /**
   * List all Gear, optionally filtered.
   */
  async list(filter?: GearListFilter): Promise<GearManifest[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.origin !== undefined) {
      conditions.push('origin = ?');
      params.push(filter.origin);
    }

    if (filter?.enabled !== undefined) {
      conditions.push('enabled = ?');
      params.push(filter.enabled ? 1 : 0);
    }

    if (filter?.draft !== undefined) {
      conditions.push('draft = ?');
      params.push(filter.draft ? 1 : 0);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.db.query<GearRow>(
      'meridian',
      `SELECT * FROM gear${where} ORDER BY name`,
      params,
    );

    return rows.map((row) => JSON.parse(row.manifest_json) as GearManifest);
  }

  /**
   * Enable a Gear.
   */
  async enable(gearId: string): Promise<void> {
    const result = await this.db.run(
      'meridian',
      'UPDATE gear SET enabled = 1 WHERE id = ?',
      [gearId],
    );

    if (result.changes === 0) {
      throw new NotFoundError(`Gear '${gearId}' not found`);
    }

    // Refresh cache
    const manifest = await this.get(gearId);
    if (manifest) {
      this.manifestCache.set(gearId, manifest);
    }

    this.logger.info('Gear enabled', { gearId });
  }

  /**
   * Disable a Gear.
   */
  async disable(gearId: string): Promise<void> {
    const result = await this.db.run(
      'meridian',
      'UPDATE gear SET enabled = 0 WHERE id = ?',
      [gearId],
    );

    if (result.changes === 0) {
      throw new NotFoundError(`Gear '${gearId}' not found`);
    }

    // Remove from cache — disabled Gear should not be used in plan validation
    this.manifestCache.delete(gearId);

    this.logger.info('Gear disabled', { gearId });
  }

  /**
   * Update Gear-specific configuration (config_json column).
   */
  async updateConfig(
    gearId: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.db.run(
      'meridian',
      'UPDATE gear SET config_json = ? WHERE id = ?',
      [JSON.stringify(config), gearId],
    );

    if (result.changes === 0) {
      throw new NotFoundError(`Gear '${gearId}' not found`);
    }

    this.logger.info('Gear config updated', { gearId });
  }

  /**
   * Get the stored configuration for a Gear.
   */
  async getConfig(gearId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db.query<GearRow>(
      'meridian',
      'SELECT config_json FROM gear WHERE id = ?',
      [gearId],
    );

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`Gear '${gearId}' not found`);
    }

    const configJson = row.config_json;
    return configJson ? (JSON.parse(configJson) as Record<string, unknown>) : null;
  }

  /**
   * Check if a Gear is enabled.
   */
  async isEnabled(gearId: string): Promise<boolean> {
    const rows = await this.db.query<{ enabled: number }>(
      'meridian',
      'SELECT enabled FROM gear WHERE id = ?',
      [gearId],
    );

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`Gear '${gearId}' not found`);
    }

    return row.enabled === 1;
  }

  /**
   * Get the stored checksum for a Gear (for execution-time integrity checks).
   */
  async getChecksum(gearId: string): Promise<string> {
    const rows = await this.db.query<{ checksum: string }>(
      'meridian',
      'SELECT checksum FROM gear WHERE id = ?',
      [gearId],
    );

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`Gear '${gearId}' not found`);
    }

    return row.checksum;
  }

  // -------------------------------------------------------------------------
  // Built-in Gear auto-registration
  // -------------------------------------------------------------------------

  /**
   * Auto-register built-in Gear on first startup.
   * Uses INSERT OR IGNORE so re-running is safe (idempotent).
   */
  async registerBuiltins(builtins: BuiltinGearDefinition[]): Promise<void> {
    for (const builtin of builtins) {
      await this.installBuiltin(builtin.manifest);
    }

    this.logger.info('Built-in Gear registration complete', {
      count: builtins.length,
    });
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  /**
   * Load all enabled Gear manifests into the in-memory cache.
   * Call this during startup after database migration.
   */
  async loadCache(): Promise<void> {
    const manifests = await this.list({ enabled: true });

    this.manifestCache.clear();
    for (const manifest of manifests) {
      this.manifestCache.set(manifest.id, manifest);
    }

    this.logger.info('Gear cache loaded', { count: manifests.length });
  }

  /**
   * Get the number of cached (enabled) Gear.
   */
  get cacheSize(): number {
    return this.manifestCache.size;
  }
}
