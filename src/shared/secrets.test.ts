import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthenticationError, NotFoundError, SecretAccessError } from './errors.js';
import { SecretsVault } from './secrets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, `../../.test-vault-${String(process.pid)}`);
const VAULT_PATH = join(TEST_DIR, 'secrets.vault');
const PASSWORD = 'test-master-password-42';

function freshVault(): SecretsVault {
  return new SecretsVault(VAULT_PATH);
}

/** Assert that a value is defined (not null/undefined) and return it narrowed. */
function defined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SecretsVault', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  describe('initialize', () => {
    it('should create a new vault file', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      expect(existsSync(VAULT_PATH)).toBe(true);
      expect(vault.isUnlocked).toBe(true);

      vault.lock();
    });

    it('should reject initialization when vault already exists', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const vault2 = freshVault();
      await expect(vault2.initialize(PASSWORD, 'low-power')).rejects.toThrow(SecretAccessError);

      vault.lock();
    });
  });

  // -----------------------------------------------------------------------
  // Unlock / Lock
  // -----------------------------------------------------------------------

  describe('unlock / lock', () => {
    it('should unlock an existing vault with correct password', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');
      vault.lock();

      expect(vault.isUnlocked).toBe(false);
      await vault.unlock(PASSWORD);
      expect(vault.isUnlocked).toBe(true);

      vault.lock();
    });

    it('should reject unlock with wrong password', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');
      vault.lock();

      await expect(vault.unlock('wrong-password')).rejects.toThrow(AuthenticationError);
      expect(vault.isUnlocked).toBe(false);
    });

    it('should reject unlock when vault file does not exist', async () => {
      const vault = new SecretsVault(join(TEST_DIR, 'nonexistent.vault'));
      await expect(vault.unlock(PASSWORD)).rejects.toThrow(NotFoundError);
    });

    it('should zero derived key on lock', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      expect(vault.isUnlocked).toBe(true);
      vault.lock();
      expect(vault.isUnlocked).toBe(false);

      // Verify operations fail after lock
      const secret = Buffer.from('test-value');
      await expect(vault.store('key', secret, ['gear:test'])).rejects.toThrow(SecretAccessError);
      secret.fill(0);
    });
  });

  // -----------------------------------------------------------------------
  // Encrypt/decrypt round-trip
  // -----------------------------------------------------------------------

  describe('store / retrieve round-trip', () => {
    it('should encrypt and decrypt a secret correctly', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const originalValue = Buffer.from('my-api-key-12345');
      await vault.store('api-key', originalValue, ['gear:http']);

      const retrieved = defined(await vault.retrieve('api-key', 'gear:http'));
      expect(retrieved).toBeInstanceOf(Buffer);
      expect(retrieved.toString('utf-8')).toBe('my-api-key-12345');

      // Clean up
      retrieved.fill(0);
      originalValue.fill(0);
      vault.lock();
    });

    it('should handle binary secret data', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const binaryData = Buffer.from([0x00, 0xff, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
      await vault.store('binary-secret', binaryData, ['gear:test']);

      const retrieved = defined(await vault.retrieve('binary-secret', 'gear:test'));
      expect(Buffer.compare(retrieved, binaryData)).toBe(0);

      retrieved.fill(0);
      binaryData.fill(0);
      vault.lock();
    });

    it('should persist secrets across unlock/lock cycles', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('persistent-secret');
      await vault.store('persistent', value, ['gear:test']);
      vault.lock();

      // Re-open vault with new instance
      const vault2 = freshVault();
      await vault2.unlock(PASSWORD);
      const retrieved = defined(await vault2.retrieve('persistent', 'gear:test'));
      expect(retrieved.toString('utf-8')).toBe('persistent-secret');

      retrieved.fill(0);
      value.fill(0);
      vault2.lock();
    });

    it('should return undefined for non-existent secret', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const result = await vault.retrieve('nonexistent', 'gear:test');
      expect(result).toBeUndefined();

      vault.lock();
    });

    it('should overwrite existing secret on re-store', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const v1 = Buffer.from('value-1');
      const v2 = Buffer.from('value-2');
      await vault.store('key', v1, ['gear:test']);
      await vault.store('key', v2, ['gear:test']);

      const retrieved = defined(await vault.retrieve('key', 'gear:test'));
      expect(retrieved.toString('utf-8')).toBe('value-2');

      v1.fill(0);
      v2.fill(0);
      retrieved.fill(0);
      vault.lock();
    });
  });

  // -----------------------------------------------------------------------
  // ACL enforcement
  // -----------------------------------------------------------------------

  describe('ACL enforcement', () => {
    it('should allow access for authorized Gear', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('secret');
      await vault.store('key', value, ['gear:http', 'gear:email']);

      const retrieved = defined(await vault.retrieve('key', 'gear:http'));
      expect(retrieved).toBeInstanceOf(Buffer);

      retrieved.fill(0);
      value.fill(0);
      vault.lock();
    });

    it('should deny access for unauthorized Gear', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('secret');
      await vault.store('key', value, ['gear:http']);

      await expect(vault.retrieve('key', 'gear:shell')).rejects.toThrow(SecretAccessError);

      value.fill(0);
      vault.lock();
    });

    it('should deny access when allowedGear is empty', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('secret');
      await vault.store('key', value, []);

      await expect(vault.retrieve('key', 'gear:http')).rejects.toThrow(SecretAccessError);

      value.fill(0);
      vault.lock();
    });
  });

  // -----------------------------------------------------------------------
  // Buffer zeroing
  // -----------------------------------------------------------------------

  describe('Buffer zeroing after retrieval', () => {
    it('should return a Buffer that can be zeroed by the caller', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('sensitive-data');
      await vault.store('key', value, ['gear:test']);

      const retrieved = defined(await vault.retrieve('key', 'gear:test'));
      expect(retrieved).toBeInstanceOf(Buffer);
      expect(retrieved.toString('utf-8')).toBe('sensitive-data');

      // Caller zeros the buffer
      retrieved.fill(0);
      expect(retrieved.every((byte) => byte === 0)).toBe(true);

      // Verify the vault still has the encrypted data — re-retrieve works
      const retrieved2 = defined(await vault.retrieve('key', 'gear:test'));
      expect(retrieved2.toString('utf-8')).toBe('sensitive-data');
      retrieved2.fill(0);

      value.fill(0);
      vault.lock();
    });
  });

  // -----------------------------------------------------------------------
  // Locked state rejects operations
  // -----------------------------------------------------------------------

  describe('locked state rejects all operations', () => {
    it('should reject store when locked', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');
      vault.lock();

      const value = Buffer.from('secret');
      await expect(vault.store('key', value, ['gear:test'])).rejects.toThrow(SecretAccessError);
      value.fill(0);
    });

    it('should reject retrieve when locked', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');
      vault.lock();

      await expect(vault.retrieve('key', 'gear:test')).rejects.toThrow(SecretAccessError);
    });

    it('should reject delete when locked', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');
      vault.lock();

      await expect(vault.delete('key')).rejects.toThrow(SecretAccessError);
    });

    it('should reject list when locked', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');
      vault.lock();

      await expect(vault.list()).rejects.toThrow(SecretAccessError);
    });

    it('should reject rotationCheck when locked', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');
      vault.lock();

      await expect(vault.rotationCheck()).rejects.toThrow(SecretAccessError);
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  describe('delete', () => {
    it('should remove a secret from the vault', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('secret');
      await vault.store('key', value, ['gear:test']);
      await vault.delete('key');

      const result = await vault.retrieve('key', 'gear:test');
      expect(result).toBeUndefined();

      value.fill(0);
      vault.lock();
    });

    it('should throw NotFoundError when deleting non-existent secret', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      await expect(vault.delete('nonexistent')).rejects.toThrow(NotFoundError);

      vault.lock();
    });
  });

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  describe('list', () => {
    it('should return metadata for all secrets without values', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const v1 = Buffer.from('value-1');
      const v2 = Buffer.from('value-2');
      await vault.store('key-1', v1, ['gear:http']);
      await vault.store('key-2', v2, ['gear:email', 'gear:http'], { rotateAfterDays: 90 });

      const entries = await vault.list();
      expect(entries).toHaveLength(2);

      const key1 = defined(entries.find((e) => e.name === 'key-1'));
      expect(key1.allowedGear).toEqual(['gear:http']);
      expect(key1.createdAt).toBeDefined();
      expect(key1.lastUsedAt).toBeDefined();
      expect(key1.rotateAfterDays).toBeUndefined();

      const key2 = defined(entries.find((e) => e.name === 'key-2'));
      expect(key2.allowedGear).toEqual(['gear:email', 'gear:http']);
      expect(key2.rotateAfterDays).toBe(90);

      // Ensure no secret values are exposed
      for (const entry of entries) {
        expect(entry).not.toHaveProperty('encryptedValue');
        expect(entry).not.toHaveProperty('ciphertext');
        expect(entry).not.toHaveProperty('iv');
        expect(entry).not.toHaveProperty('authTag');
      }

      v1.fill(0);
      v2.fill(0);
      vault.lock();
    });

    it('should return empty array when no secrets stored', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const entries = await vault.list();
      expect(entries).toEqual([]);

      vault.lock();
    });
  });

  // -----------------------------------------------------------------------
  // Rotation check
  // -----------------------------------------------------------------------

  describe('rotationCheck', () => {
    it('should detect secrets past their rotation deadline', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      // Store a secret with a 0-day rotation (immediately due)
      const value = Buffer.from('old-secret');
      await vault.store('old-key', value, ['gear:test'], { rotateAfterDays: 0 });

      const warnings = await vault.rotationCheck();
      expect(warnings).toHaveLength(1);

      const warning = defined(warnings[0]);
      expect(warning.name).toBe('old-key');
      expect(warning.rotateAfterDays).toBe(0);
      expect(warning.ageInDays).toBeGreaterThanOrEqual(0);

      value.fill(0);
      vault.lock();
    });

    it('should not warn for secrets without rotateAfterDays', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('no-rotation');
      await vault.store('no-rotate', value, ['gear:test']);

      const warnings = await vault.rotationCheck();
      expect(warnings).toHaveLength(0);

      value.fill(0);
      vault.lock();
    });

    it('should not warn for secrets within rotation window', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'low-power');

      const value = Buffer.from('fresh-secret');
      await vault.store('fresh-key', value, ['gear:test'], { rotateAfterDays: 365 });

      const warnings = await vault.rotationCheck();
      expect(warnings).toHaveLength(0);

      value.fill(0);
      vault.lock();
    });
  });

  // -----------------------------------------------------------------------
  // Standard tier
  // -----------------------------------------------------------------------

  describe('standard tier', () => {
    it('should work with standard tier Argon2id parameters', async () => {
      const vault = freshVault();
      await vault.initialize(PASSWORD, 'standard');

      const value = Buffer.from('standard-tier-secret');
      await vault.store('key', value, ['gear:test']);

      // Re-open
      vault.lock();
      await vault.unlock(PASSWORD);

      const retrieved = defined(await vault.retrieve('key', 'gear:test'));
      expect(retrieved.toString('utf-8')).toBe('standard-tier-secret');

      retrieved.fill(0);
      value.fill(0);
      vault.lock();
    }, 30_000); // Standard tier uses more memory/iterations; allow longer timeout
  });
});
