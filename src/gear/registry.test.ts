// @meridian/gear — Gear registry CRUD tests (Phase 5.1)

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { GearManifest } from '@meridian/shared';
import { DatabaseClient, migrate } from '@meridian/shared';

import { GearRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createValidManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'test-gear',
    name: 'Test Gear',
    version: '1.0.0',
    description: 'A test Gear for unit tests',
    author: 'Meridian',
    license: 'Apache-2.0',
    origin: 'user',
    checksum: 'placeholder-will-be-computed',
    actions: [
      {
        name: 'test_action',
        description: 'A test action',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        returns: {
          type: 'object',
          properties: { output: { type: 'string' } },
        },
        riskLevel: 'low',
      },
    ],
    permissions: {
      filesystem: {
        read: ['workspace/**'],
      },
    },
    ...overrides,
  };
}

function createBuiltinManifest(id: string, name: string): GearManifest {
  return createValidManifest({
    id,
    name,
    origin: 'builtin',
    actions: [
      {
        name: 'default_action',
        description: `Default action for ${name}`,
        parameters: { type: 'object', properties: {} },
        returns: { type: 'object', properties: {} },
        riskLevel: 'low',
      },
    ],
  });
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let packagePath: string;
let db: DatabaseClient;
let registry: GearRegistry;

beforeEach(async () => {
  // Create temp dir for database and package files
  tempDir = mkdtempSync(join(tmpdir(), 'meridian-gear-reg-'));
  packagePath = join(tempDir, 'test-gear.js');
  writeFileSync(packagePath, 'module.exports = { run() {} }');

  // Create database client (direct mode for testing)
  db = new DatabaseClient({ dataDir: tempDir, direct: true });
  await db.start();
  await db.open('meridian');

  // Run migrations to create the gear table
  await migrate(db, 'meridian', process.cwd());

  registry = new GearRegistry(db, noopLogger);
});

afterEach(async () => {
  await db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: install
// ---------------------------------------------------------------------------

describe('GearRegistry', () => {
  describe('install', () => {
    it('should install a valid Gear', async () => {
      const manifest = createValidManifest();
      const result = await registry.install(manifest, packagePath);

      expect(result.ok).toBe(true);

      // Verify it's stored in the database
      const stored = await registry.get('test-gear');
      expect(stored).toBeDefined();
      expect(stored?.id).toBe('test-gear');
      expect(stored?.name).toBe('Test Gear');
      expect(stored?.version).toBe('1.0.0');
    });

    it('should compute and store the checksum', async () => {
      const manifest = createValidManifest();
      await registry.install(manifest, packagePath);

      const stored = await registry.get('test-gear');
      expect(stored).toBeDefined();
      // Checksum should be a 64-char hex string (SHA-256)
      expect(stored?.checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should reject duplicate installation', async () => {
      const manifest = createValidManifest();
      await registry.install(manifest, packagePath);

      await expect(registry.install(manifest, packagePath)).rejects.toThrow(
        /already installed/,
      );
    });

    it('should reject invalid manifests', async () => {
      const manifest = createValidManifest({ version: 'not-semver' });
      const result = await registry.install(manifest, packagePath);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.type === 'invalid_version')).toBe(true);
      }
    });

    it('should store Gear as enabled by default', async () => {
      const manifest = createValidManifest();
      await registry.install(manifest, packagePath);

      const isEnabled = await registry.isEnabled('test-gear');
      expect(isEnabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: uninstall
  // ---------------------------------------------------------------------------

  describe('uninstall', () => {
    it('should remove an installed Gear', async () => {
      const manifest = createValidManifest();
      await registry.install(manifest, packagePath);
      await registry.uninstall('test-gear');

      const stored = await registry.get('test-gear');
      expect(stored).toBeUndefined();
    });

    it('should throw NotFoundError for unknown Gear', async () => {
      await expect(registry.uninstall('nonexistent')).rejects.toThrow(/not found/);
    });

    it('should evict Gear from cache after uninstall', async () => {
      const manifest = createValidManifest();
      await registry.install(manifest, packagePath);

      // Should be in cache
      expect(registry.getManifest('test-gear')).toBeDefined();

      await registry.uninstall('test-gear');

      // Should be evicted from cache
      expect(registry.getManifest('test-gear')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: get
  // ---------------------------------------------------------------------------

  describe('get', () => {
    it('should return installed Gear', async () => {
      const manifest = createValidManifest();
      await registry.install(manifest, packagePath);

      const stored = await registry.get('test-gear');
      expect(stored).toBeDefined();
      expect(stored?.id).toBe('test-gear');
    });

    it('should return undefined for non-existent Gear', async () => {
      const stored = await registry.get('nonexistent');
      expect(stored).toBeUndefined();
    });

    it('should return the full manifest with all fields', async () => {
      const manifest = createValidManifest({
        repository: 'https://github.com/test/gear',
        resources: {
          maxMemoryMb: 512,
          maxCpuPercent: 80,
        },
      });
      await registry.install(manifest, packagePath);

      const stored = await registry.get('test-gear');
      expect(stored?.repository).toBe('https://github.com/test/gear');
      expect(stored?.resources?.maxMemoryMb).toBe(512);
      expect(stored?.resources?.maxCpuPercent).toBe(80);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: list
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('should return an empty array when no Gear installed', async () => {
      const list = await registry.list();
      expect(list).toEqual([]);
    });

    it('should return all installed Gear', async () => {
      const pkg1 = join(tempDir, 'gear1.js');
      const pkg2 = join(tempDir, 'gear2.js');
      writeFileSync(pkg1, 'module.exports = {}');
      writeFileSync(pkg2, 'module.exports = {}');

      await registry.install(createValidManifest({ id: 'alpha-gear', name: 'Alpha' }), pkg1);
      await registry.install(createValidManifest({ id: 'beta-gear', name: 'Beta' }), pkg2);

      const list = await registry.list();
      expect(list).toHaveLength(2);
      // Alphabetical order by name
      expect(list[0]?.name).toBe('Alpha');
      expect(list[1]?.name).toBe('Beta');
    });

    it('should filter by origin', async () => {
      await registry.installBuiltin(createBuiltinManifest('builtin-gear', 'Builtin'));
      await registry.install(createValidManifest({ id: 'user-gear', name: 'User' }), packagePath);

      const builtins = await registry.list({ origin: 'builtin' });
      expect(builtins).toHaveLength(1);
      expect(builtins[0]?.id).toBe('builtin-gear');
    });

    it('should filter by enabled state', async () => {
      await registry.install(createValidManifest({ id: 'enabled-gear', name: 'Enabled' }), packagePath);

      const pkg2 = join(tempDir, 'disabled.js');
      writeFileSync(pkg2, 'module.exports = {}');
      await registry.install(createValidManifest({ id: 'disabled-gear', name: 'Disabled' }), pkg2);
      await registry.disable('disabled-gear');

      const enabled = await registry.list({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0]?.id).toBe('enabled-gear');

      const disabled = await registry.list({ enabled: false });
      expect(disabled).toHaveLength(1);
      expect(disabled[0]?.id).toBe('disabled-gear');
    });

    it('should filter by draft state', async () => {
      await registry.install(
        createValidManifest({ id: 'draft-gear', name: 'Draft', origin: 'journal', draft: true }),
        packagePath,
      );

      const drafts = await registry.list({ draft: true });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.id).toBe('draft-gear');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: enable / disable
  // ---------------------------------------------------------------------------

  describe('enable / disable', () => {
    it('should disable an enabled Gear', async () => {
      await registry.install(createValidManifest(), packagePath);
      await registry.disable('test-gear');

      const isEnabled = await registry.isEnabled('test-gear');
      expect(isEnabled).toBe(false);
    });

    it('should re-enable a disabled Gear', async () => {
      await registry.install(createValidManifest(), packagePath);
      await registry.disable('test-gear');
      await registry.enable('test-gear');

      const isEnabled = await registry.isEnabled('test-gear');
      expect(isEnabled).toBe(true);
    });

    it('should evict disabled Gear from cache', async () => {
      await registry.install(createValidManifest(), packagePath);
      expect(registry.getManifest('test-gear')).toBeDefined();

      await registry.disable('test-gear');
      expect(registry.getManifest('test-gear')).toBeUndefined();
    });

    it('should restore enabled Gear to cache', async () => {
      await registry.install(createValidManifest(), packagePath);
      await registry.disable('test-gear');
      expect(registry.getManifest('test-gear')).toBeUndefined();

      await registry.enable('test-gear');
      expect(registry.getManifest('test-gear')).toBeDefined();
    });

    it('should throw NotFoundError when enabling non-existent Gear', async () => {
      await expect(registry.enable('nonexistent')).rejects.toThrow(/not found/);
    });

    it('should throw NotFoundError when disabling non-existent Gear', async () => {
      await expect(registry.disable('nonexistent')).rejects.toThrow(/not found/);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: updateConfig
  // ---------------------------------------------------------------------------

  describe('updateConfig', () => {
    it('should store configuration for a Gear', async () => {
      await registry.install(createValidManifest(), packagePath);
      await registry.updateConfig('test-gear', { apiKey: 'abc123', timeout: 5000 });

      const config = await registry.getConfig('test-gear');
      expect(config).toEqual({ apiKey: 'abc123', timeout: 5000 });
    });

    it('should overwrite existing configuration', async () => {
      await registry.install(createValidManifest(), packagePath);
      await registry.updateConfig('test-gear', { key: 'old' });
      await registry.updateConfig('test-gear', { key: 'new', extra: true });

      const config = await registry.getConfig('test-gear');
      expect(config).toEqual({ key: 'new', extra: true });
    });

    it('should return null for Gear with no configuration', async () => {
      await registry.install(createValidManifest(), packagePath);
      const config = await registry.getConfig('test-gear');
      expect(config).toBeNull();
    });

    it('should throw NotFoundError for non-existent Gear', async () => {
      await expect(
        registry.updateConfig('nonexistent', { key: 'value' }),
      ).rejects.toThrow(/not found/);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: built-in auto-registration
  // ---------------------------------------------------------------------------

  describe('registerBuiltins', () => {
    it('should register multiple built-in Gear', async () => {
      const builtins = [
        { manifest: createBuiltinManifest('file-manager', 'File Manager'), packagePath },
        { manifest: createBuiltinManifest('web-search', 'Web Search'), packagePath },
      ];

      await registry.registerBuiltins(builtins);

      const list = await registry.list({ origin: 'builtin' });
      expect(list).toHaveLength(2);
    });

    it('should be idempotent (INSERT OR IGNORE)', async () => {
      const builtins = [
        { manifest: createBuiltinManifest('file-manager', 'File Manager'), packagePath },
      ];

      await registry.registerBuiltins(builtins);
      // Second registration should not throw
      await registry.registerBuiltins(builtins);

      const list = await registry.list({ origin: 'builtin' });
      expect(list).toHaveLength(1);
    });

    it('should add built-in Gear to the cache', async () => {
      const builtins = [
        { manifest: createBuiltinManifest('file-manager', 'File Manager'), packagePath },
      ];

      await registry.registerBuiltins(builtins);

      expect(registry.getManifest('file-manager')).toBeDefined();
      expect(registry.getManifest('file-manager')?.name).toBe('File Manager');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: cache management
  // ---------------------------------------------------------------------------

  describe('loadCache', () => {
    it('should load all enabled Gear into cache', async () => {
      await registry.install(createValidManifest({ id: 'gear-a', name: 'A' }), packagePath);

      const pkg2 = join(tempDir, 'gear-b.js');
      writeFileSync(pkg2, 'module.exports = {}');
      await registry.install(createValidManifest({ id: 'gear-b', name: 'B' }), pkg2);

      // Clear cache and reload
      await registry.loadCache();

      expect(registry.cacheSize).toBe(2);
      expect(registry.getManifest('gear-a')).toBeDefined();
      expect(registry.getManifest('gear-b')).toBeDefined();
    });

    it('should exclude disabled Gear from cache', async () => {
      await registry.install(createValidManifest({ id: 'gear-a', name: 'A' }), packagePath);

      const pkg2 = join(tempDir, 'gear-b.js');
      writeFileSync(pkg2, 'module.exports = {}');
      await registry.install(createValidManifest({ id: 'gear-b', name: 'B' }), pkg2);
      await registry.disable('gear-b');

      await registry.loadCache();

      expect(registry.cacheSize).toBe(1);
      expect(registry.getManifest('gear-a')).toBeDefined();
      expect(registry.getManifest('gear-b')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: GearLookup interface
  // ---------------------------------------------------------------------------

  describe('GearLookup interface', () => {
    it('should satisfy GearLookup with getManifest', async () => {
      await registry.install(createValidManifest(), packagePath);

      // Use the registry as a GearLookup
      const manifest = registry.getManifest('test-gear');
      expect(manifest).toBeDefined();
      expect(manifest?.id).toBe('test-gear');
    });

    it('should return undefined for non-existent Gear via GearLookup', () => {
      const manifest = registry.getManifest('nonexistent');
      expect(manifest).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: getChecksum
  // ---------------------------------------------------------------------------

  describe('getChecksum', () => {
    it('should return the stored checksum', async () => {
      await registry.install(createValidManifest(), packagePath);
      const checksum = await registry.getChecksum('test-gear');
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should throw NotFoundError for non-existent Gear', async () => {
      await expect(registry.getChecksum('nonexistent')).rejects.toThrow(/not found/);
    });
  });
});
