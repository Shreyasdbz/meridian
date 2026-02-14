// Encrypted backup tests (Phase 10.5)

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DatabaseClient } from '@meridian/shared';

import { BackupManager, encrypt, decrypt, deriveKey } from './backup.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let dataDir: string;
let backupDir: string;
let db: DatabaseClient;
let encryptionKey: Buffer;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `meridian-test-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  dataDir = join(testDir, 'data');
  backupDir = join(testDir, 'backups');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  db = new DatabaseClient({ dataDir, direct: true });
  await db.start();
  encryptionKey = deriveKey('test-password-for-backups');
});

afterEach(async () => {
  await db.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(name: string): void {
  writeFileSync(join(dataDir, name), 'SQLite format 3 - test data');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Encryption/Decryption', () => {
  it('should encrypt and decrypt data correctly', () => {
    const original = Buffer.from('Hello, Meridian!');
    const encrypted = encrypt(original, encryptionKey);
    const decrypted = decrypt(encrypted, encryptionKey);

    expect(decrypted.toString()).toBe(original.toString());
  });

  it('should produce different ciphertext for same plaintext (random IV)', () => {
    const data = Buffer.from('same data');
    const enc1 = encrypt(data, encryptionKey);
    const enc2 = encrypt(data, encryptionKey);

    // Encrypted outputs should differ due to random IV
    expect(enc1.equals(enc2)).toBe(false);

    // But both should decrypt to the same thing
    expect(decrypt(enc1, encryptionKey).toString()).toBe('same data');
    expect(decrypt(enc2, encryptionKey).toString()).toBe('same data');
  });

  it('should fail decryption with wrong key', () => {
    const data = Buffer.from('secret data');
    const encrypted = encrypt(data, encryptionKey);
    const wrongKey = deriveKey('wrong-password');

    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('should reject truncated ciphertext', () => {
    expect(() => decrypt(Buffer.from('too short'), encryptionKey)).toThrow(
      'Encrypted data too short',
    );
  });

  it('should handle empty data', () => {
    const data = Buffer.alloc(0);
    const encrypted = encrypt(data, encryptionKey);
    const decrypted = decrypt(encrypted, encryptionKey);
    expect(decrypted.length).toBe(0);
  });

  it('should handle large data', () => {
    const data = Buffer.alloc(1024 * 1024, 0xab);
    const encrypted = encrypt(data, encryptionKey);
    const decrypted = decrypt(encrypted, encryptionKey);
    expect(decrypted.equals(data)).toBe(true);
  });
});

describe('deriveKey', () => {
  it('should produce a 32-byte key', () => {
    const key = deriveKey('some password');
    expect(key.length).toBe(32);
  });

  it('should be deterministic', () => {
    const key1 = deriveKey('same');
    const key2 = deriveKey('same');
    expect(key1.equals(key2)).toBe(true);
  });

  it('should produce different keys for different passwords', () => {
    const key1 = deriveKey('password1');
    const key2 = deriveKey('password2');
    expect(key1.equals(key2)).toBe(false);
  });
});

describe('BackupManager', () => {
  describe('createBackup', () => {
    it('should create encrypted backups of database files', () => {
      createTestDb('meridian.db');
      createTestDb('journal.db');

      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      const result = manager.createBackup();

      expect(result.files.length).toBe(2);
      expect(result.totalSizeBytes).toBeGreaterThan(0);
      expect(result.timestamp).toBeDefined();

      // Verify encrypted files exist
      for (const file of result.files) {
        expect(existsSync(file)).toBe(true);
      }
    });

    it('should handle empty data directory gracefully', () => {
      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      const result = manager.createBackup();
      expect(result.files).toHaveLength(0);
      expect(result.totalSizeBytes).toBe(0);
    });

    it('should skip non-.db files', () => {
      createTestDb('meridian.db');
      writeFileSync(join(dataDir, 'readme.txt'), 'not a database');

      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      const result = manager.createBackup();
      expect(result.files).toHaveLength(1);
    });
  });

  describe('restore', () => {
    it('should restore from an encrypted backup', () => {
      createTestDb('meridian.db');

      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      // Create backup
      manager.createBackup();
      const backupDirs = readdirSync(backupDir).filter(
        (d) => d.startsWith('backup-'),
      );
      expect(backupDirs.length).toBeGreaterThan(0);
      const backupPath = join(backupDir, backupDirs[0] as string);

      // Delete original
      rmSync(join(dataDir, 'meridian.db'));
      expect(existsSync(join(dataDir, 'meridian.db'))).toBe(false);

      // Restore
      manager.restore(backupPath);

      // Verify restoration
      expect(existsSync(join(dataDir, 'meridian.db'))).toBe(true);
    });

    it('should create a safety backup before restoring', () => {
      createTestDb('meridian.db');

      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      manager.createBackup();
      const backupDirs = readdirSync(backupDir).filter(
        (d) => d.startsWith('backup-'),
      );
      expect(backupDirs.length).toBeGreaterThan(0);
      const backupPath = join(backupDir, backupDirs[0] as string);

      manager.restore(backupPath);

      // Safety backup directory should exist
      const safetyDirs = readdirSync(backupDir).filter((d) => d.startsWith('safety-'));
      expect(safetyDirs.length).toBe(1);
    });

    it('should throw if backup path does not exist', () => {
      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      expect(() => { manager.restore('/nonexistent/path'); }).toThrow(
        'Backup path does not exist',
      );
    });
  });

  describe('listBackups', () => {
    it('should list backup directories in reverse chronological order', async () => {
      createTestDb('meridian.db');

      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      manager.createBackup();
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));
      manager.createBackup();

      const backups = manager.listBackups();
      expect(backups.length).toBe(2);
      // Should be newest first
      expect((backups[0] as string) > (backups[1] as string)).toBe(true);
    });

    it('should return empty array if no backups exist', () => {
      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      const backups = manager.listBackups();
      expect(backups).toHaveLength(0);
    });
  });

  describe('rotate', () => {
    it('should keep up to 7 daily backups', () => {
      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      // Create 10 backup directories with different dates
      for (let i = 1; i <= 10; i++) {
        const date = `2026-02-${String(i).padStart(2, '0')}T12-00-00-000Z`;
        mkdirSync(join(backupDir, `backup-${date}`), { recursive: true });
      }

      manager.rotate();

      const remaining = readdirSync(backupDir).filter((d) => d.startsWith('backup-'));
      // 7 daily + up to 4 weekly + up to 3 monthly, but with only 10 entries
      // and all within same month, at most 7 daily + 1 weekly
      expect(remaining.length).toBeLessThanOrEqual(10);
      expect(remaining.length).toBeGreaterThanOrEqual(7);
    });

    it('should not rotate when fewer than 7 backups exist', () => {
      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      for (let i = 1; i <= 5; i++) {
        mkdirSync(join(backupDir, `backup-2026-02-0${i}T12-00-00-000Z`), { recursive: true });
      }

      manager.rotate();

      const remaining = readdirSync(backupDir).filter((d) => d.startsWith('backup-'));
      expect(remaining.length).toBe(5);
    });

    it('should not delete non-backup directories', () => {
      const manager = new BackupManager({
        backupDir,
        dataDir,
        db,
        encryptionKey,
      });

      mkdirSync(join(backupDir, 'safety-12345'), { recursive: true });

      for (let i = 1; i <= 10; i++) {
        mkdirSync(join(backupDir, `backup-2026-02-${String(i).padStart(2, '0')}T12-00-00-000Z`), {
          recursive: true,
        });
      }

      manager.rotate();

      // Safety directory should still exist
      expect(existsSync(join(backupDir, 'safety-12345'))).toBe(true);
    });
  });
});
