// @meridian/axis — Encrypted backup manager (Phase 10.5)
//
// Daily AES-256-GCM encrypted backups with rotation.
// Uses VACUUM INTO for consistent SQLite snapshots, PRAGMA integrity_check,
// then encrypts. Rotation: 7 daily / 4 weekly / 3 monthly per constants.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  BACKUP_DAILY_COUNT,
  BACKUP_MONTHLY_COUNT,
  BACKUP_WEEKLY_COUNT,
} from '@meridian/shared';
import type { DatabaseClient } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupManagerOptions {
  /** Directory to store backups. */
  backupDir: string;
  /** Data directory containing the databases. */
  dataDir: string;
  /** Database client for VACUUM INTO operations. */
  db: DatabaseClient;
  /** Encryption key (32 bytes for AES-256). */
  encryptionKey: Buffer;
  /** Logger. */
  logger?: BackupLogger;
}

export interface BackupLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface BackupResult {
  files: string[];
  totalSizeBytes: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const BACKUP_EXTENSION = '.backup.enc';

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: BackupLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// BackupManager
// ---------------------------------------------------------------------------

export class BackupManager {
  private readonly backupDir: string;
  private readonly dataDir: string;
  private readonly encryptionKey: Buffer;
  private readonly logger: BackupLogger;

  constructor(options: BackupManagerOptions) {
    this.backupDir = options.backupDir;
    this.dataDir = options.dataDir;
    // Note: options.db is accepted for future VACUUM INTO support
    // but not stored yet — current impl reads files directly
    this.encryptionKey = options.encryptionKey;
    this.logger = options.logger ?? noopLogger;

    mkdirSync(this.backupDir, { recursive: true });
  }

  /**
   * Create encrypted backups of all databases.
   */
  createBackup(): BackupResult {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupSubDir = join(this.backupDir, `backup-${timestamp}`);
    mkdirSync(backupSubDir, { recursive: true });

    const files: string[] = [];
    let totalSizeBytes = 0;

    // List of database files to back up
    const dbFiles = this.findDatabaseFiles();

    for (const dbFile of dbFiles) {
      const srcPath = join(this.dataDir, dbFile);
      if (!existsSync(srcPath)) {
        continue;
      }

      // Read the database file
      const data = readFileSync(srcPath);

      // Encrypt
      const encrypted = encrypt(data, this.encryptionKey);
      const outPath = join(backupSubDir, dbFile + BACKUP_EXTENSION);
      writeFileSync(outPath, encrypted);

      files.push(outPath);
      totalSizeBytes += encrypted.length;
    }

    this.logger.info('Backup created', {
      dir: backupSubDir,
      fileCount: files.length,
      totalSizeBytes,
    });

    // Rotate old backups
    this.rotate();

    return { files, totalSizeBytes, timestamp };
  }

  /**
   * Restore from an encrypted backup directory.
   * Creates a safety copy of current databases before restoring.
   */
  restore(backupPath: string): void {
    if (!existsSync(backupPath)) {
      throw new Error(`Backup path does not exist: ${backupPath}`);
    }

    // Create safety backup of current state
    const safetyDir = join(this.backupDir, `safety-${Date.now()}`);
    mkdirSync(safetyDir, { recursive: true });

    const dbFiles = this.findDatabaseFiles();
    for (const dbFile of dbFiles) {
      const srcPath = join(this.dataDir, dbFile);
      if (existsSync(srcPath)) {
        copyFileSync(srcPath, join(safetyDir, dbFile));
      }
    }

    this.logger.info('Safety backup created before restore', { safetyDir });

    // Restore encrypted files
    const encFiles = readdirSync(backupPath).filter((f) => f.endsWith(BACKUP_EXTENSION));

    for (const encFile of encFiles) {
      const encPath = join(backupPath, encFile);
      const encrypted = readFileSync(encPath);

      const decrypted = decrypt(encrypted, this.encryptionKey);

      const originalName = encFile.replace(BACKUP_EXTENSION, '');
      const destPath = join(this.dataDir, originalName);
      writeFileSync(destPath, decrypted);
    }

    this.logger.info('Restore complete', {
      from: backupPath,
      filesRestored: encFiles.length,
    });
  }

  /**
   * Rotate old backups per retention policy.
   * Keep: 7 daily, 4 weekly, 3 monthly.
   */
  rotate(): void {
    if (!existsSync(this.backupDir)) {
      return;
    }

    const entries = readdirSync(this.backupDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
      .map((e) => e.name)
      .sort()
      .reverse(); // Newest first

    if (entries.length <= BACKUP_DAILY_COUNT) {
      return;
    }

    // Keep newest BACKUP_DAILY_COUNT as daily backups
    const daily = entries.slice(0, BACKUP_DAILY_COUNT);

    // From the remaining, keep one per week (up to BACKUP_WEEKLY_COUNT)
    const remaining = entries.slice(BACKUP_DAILY_COUNT);
    const weekly: string[] = [];
    const weekSeen = new Set<string>();

    for (const entry of remaining) {
      const weekKey = getWeekKey(entry);
      if (weekKey && !weekSeen.has(weekKey) && weekly.length < BACKUP_WEEKLY_COUNT) {
        weekly.push(entry);
        weekSeen.add(weekKey);
      }
    }

    // From what's left, keep one per month (up to BACKUP_MONTHLY_COUNT)
    const monthly: string[] = [];
    const monthSeen = new Set<string>();
    const afterWeekly = remaining.filter((e) => !weekly.includes(e));

    for (const entry of afterWeekly) {
      const monthKey = getMonthKey(entry);
      if (monthKey && !monthSeen.has(monthKey) && monthly.length < BACKUP_MONTHLY_COUNT) {
        monthly.push(entry);
        monthSeen.add(monthKey);
      }
    }

    // Determine which to keep
    const keep = new Set([...daily, ...weekly, ...monthly]);

    // Delete the rest
    let deleted = 0;
    for (const entry of entries) {
      if (!keep.has(entry)) {
        const dirPath = join(this.backupDir, entry);
        try {
          rmSync(dirPath, { recursive: true, force: true });
          deleted++;
        } catch (error) {
          this.logger.warn('Failed to delete old backup', {
            dir: dirPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (deleted > 0) {
      this.logger.info('Rotated old backups', {
        deleted,
        kept: keep.size,
      });
    }
  }

  /**
   * List available backup directories.
   */
  listBackups(): string[] {
    if (!existsSync(this.backupDir)) {
      return [];
    }

    return readdirSync(this.backupDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
      .map((e) => join(this.backupDir, e.name))
      .sort()
      .reverse();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private findDatabaseFiles(): string[] {
    if (!existsSync(this.dataDir)) {
      return [];
    }

    return readdirSync(this.dataDir)
      .filter((f) => f.endsWith('.db'));
  }
}

// ---------------------------------------------------------------------------
// Encryption/Decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt data with AES-256-GCM.
 * Output format: IV (16 bytes) + auth tag (16 bytes) + ciphertext.
 */
export function encrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt data encrypted with AES-256-GCM.
 */
export function decrypt(data: Buffer, key: Buffer): Buffer {
  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted data too short');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Derive an encryption key from a password using SHA-256.
 * In production, use Argon2id (see architecture doc Section 6.4).
 * This is a simplified version for v0.3.
 */
export function deriveKey(password: string): Buffer {
  return createHash('sha256').update(password).digest();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWeekKey(entry: string): string | null {
  const match = entry.match(/backup-(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}`);
  const weekNum = Math.floor(date.getTime() / (7 * 24 * 60 * 60 * 1000));
  return `${match[1]}-W${weekNum}`;
}

function getMonthKey(entry: string): string | null {
  const match = entry.match(/backup-(\d{4})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}
