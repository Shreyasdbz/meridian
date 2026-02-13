// @meridian/cli — Tests for update mechanism

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  checkForUpdates,
  compareSemVer,
  createPreUpdateBackup,
  findLatestBackup,
  getCurrentVersion,
  rollback,
  runCli,
  UpdateError,
  RollbackError,
} from './update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory that is cleaned up after the test. */
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'meridian-update-test-'));
}

/** Create a minimal package.json in the given directory. */
function createPackageJson(dir: string, version: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'meridian', version }),
  );
}

/** Create a fake database file in the given directory. */
function createFakeDb(dir: string, name: string, content: string = 'db-data'): void {
  writeFileSync(join(dir, name), content);
}

/** Create a mock fetch that returns a given GitHub release. */
function createMockFetch(response: {
  status?: number;
  ok?: boolean;
  body?: unknown;
}): typeof globalThis.fetch {
  const status = response.status ?? 200;
  const isOk = response.ok ?? (status >= 200 && status < 300);

  return vi.fn().mockResolvedValue({
    status,
    ok: isOk,
    json: vi.fn().mockResolvedValue(response.body ?? {}),
  }) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// compareSemVer
// ---------------------------------------------------------------------------

describe('compareSemVer', () => {
  it('should return 0 for equal versions', () => {
    expect(compareSemVer('1.0.0', '1.0.0')).toBe(0);
  });

  it('should return negative when a < b (major)', () => {
    expect(compareSemVer('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  it('should return positive when a > b (major)', () => {
    expect(compareSemVer('3.0.0', '1.0.0')).toBeGreaterThan(0);
  });

  it('should compare minor versions correctly', () => {
    expect(compareSemVer('1.2.0', '1.3.0')).toBeLessThan(0);
    expect(compareSemVer('1.5.0', '1.3.0')).toBeGreaterThan(0);
  });

  it('should compare patch versions correctly', () => {
    expect(compareSemVer('1.0.1', '1.0.2')).toBeLessThan(0);
    expect(compareSemVer('1.0.5', '1.0.3')).toBeGreaterThan(0);
  });

  it('should handle versions with v prefix', () => {
    expect(compareSemVer('v1.0.0', 'v1.0.0')).toBe(0);
    expect(compareSemVer('v0.1.0', 'v0.2.0')).toBeLessThan(0);
  });

  it('should treat pre-release as lower than release', () => {
    expect(compareSemVer('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareSemVer('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
  });

  it('should compare pre-release versions lexicographically', () => {
    expect(compareSemVer('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareSemVer('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0);
  });

  it('should return 0 for equal pre-release versions', () => {
    expect(compareSemVer('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCurrentVersion
// ---------------------------------------------------------------------------

describe('getCurrentVersion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should read version from package.json', () => {
    createPackageJson(tempDir, '0.1.0');
    expect(getCurrentVersion(tempDir)).toBe('0.1.0');
  });

  it('should throw UpdateError when package.json is missing', () => {
    expect(() => getCurrentVersion(tempDir)).toThrow(UpdateError);
  });

  it('should throw UpdateError when version field is missing', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
    expect(() => getCurrentVersion(tempDir)).toThrow(UpdateError);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdates
// ---------------------------------------------------------------------------

describe('checkForUpdates', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    createPackageJson(tempDir, '0.1.0');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should detect when an update is available', async () => {
    const mockFetch = createMockFetch({
      body: {
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/meridian-ai/meridian/releases/tag/v0.2.0',
        body: 'New features and bug fixes.',
      },
    });

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.currentVersion).toBe('0.1.0');
      expect(result.value.latestVersion).toBe('0.2.0');
      expect(result.value.updateAvailable).toBe(true);
      expect(result.value.releaseUrl).toContain('github.com');
      expect(result.value.releaseNotes).toBe('New features and bug fixes.');
    }
  });

  it('should detect when already up to date', async () => {
    const mockFetch = createMockFetch({
      body: {
        tag_name: 'v0.1.0',
        html_url: 'https://github.com/meridian-ai/meridian/releases/tag/v0.1.0',
        body: 'Initial release.',
      },
    });

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.updateAvailable).toBe(false);
    }
  });

  it('should detect when current version is ahead of latest', async () => {
    createPackageJson(tempDir, '0.3.0');
    const mockFetch = createMockFetch({
      body: {
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/meridian-ai/meridian/releases/tag/v0.2.0',
        body: 'Older release.',
      },
    });

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.updateAvailable).toBe(false);
    }
  });

  it('should handle tag_name without v prefix', async () => {
    const mockFetch = createMockFetch({
      body: {
        tag_name: '0.5.0',
        html_url: 'https://github.com/meridian-ai/meridian/releases/tag/0.5.0',
        body: 'Release notes.',
      },
    });

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.latestVersion).toBe('0.5.0');
      expect(result.value.updateAvailable).toBe(true);
    }
  });

  it('should return error when GitHub API returns 404', async () => {
    const mockFetch = createMockFetch({ status: 404, ok: false });

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No releases found');
    }
  });

  it('should return error when GitHub API returns 403 (rate limit)', async () => {
    const mockFetch = createMockFetch({ status: 403, ok: false });

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('rate limit');
    }
  });

  it('should return error when fetch throws a network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(
      new Error('Network unreachable'),
    ) as unknown as typeof globalThis.fetch;

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Network unreachable');
    }
  });

  it('should return error when response is missing tag_name', async () => {
    const mockFetch = createMockFetch({
      body: { html_url: 'https://example.com', body: '' },
    });

    const result = await checkForUpdates(tempDir, mockFetch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing tag_name');
    }
  });

  it('should send correct headers in the request', async () => {
    const mockFetch = createMockFetch({
      body: {
        tag_name: 'v0.1.0',
        html_url: 'https://example.com',
        body: '',
      },
    });

    await checkForUpdates(tempDir, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.github.com'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'meridian-update-check',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// createPreUpdateBackup
// ---------------------------------------------------------------------------

describe('createPreUpdateBackup', () => {
  let tempDir: string;
  let dataDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tempDir = createTempDir();
    dataDir = join(tempDir, 'data');
    projectRoot = join(tempDir, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    createPackageJson(projectRoot, '0.1.0');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a backup of all database files', () => {
    createFakeDb(dataDir, 'meridian.db', 'meridian-data');
    createFakeDb(dataDir, 'journal.db', 'journal-data');
    createFakeDb(dataDir, 'sentinel.db', 'sentinel-data');

    const result = createPreUpdateBackup(dataDir, projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileCount).toBe(3);
      expect(result.value.version).toBe('0.1.0');
      expect(existsSync(result.value.backupPath)).toBe(true);

      // Verify file contents are identical
      const backedUpMeridian = readFileSync(
        join(result.value.backupPath, 'meridian.db'),
        'utf-8',
      );
      expect(backedUpMeridian).toBe('meridian-data');
    }
  });

  it('should include WAL and SHM files in the backup', () => {
    createFakeDb(dataDir, 'meridian.db');
    createFakeDb(dataDir, 'meridian.db-wal', 'wal-data');
    createFakeDb(dataDir, 'meridian.db-shm', 'shm-data');

    const result = createPreUpdateBackup(dataDir, projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileCount).toBe(3);
      const files = readdirSync(result.value.backupPath);
      expect(files).toContain('meridian.db');
      expect(files).toContain('meridian.db-wal');
      expect(files).toContain('meridian.db-shm');
    }
  });

  it('should include secrets.vault in the backup if present', () => {
    createFakeDb(dataDir, 'meridian.db');
    writeFileSync(join(dataDir, 'secrets.vault'), 'encrypted-secrets');

    const result = createPreUpdateBackup(dataDir, projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileCount).toBe(2); // 1 db + 1 vault
      const vaultContent = readFileSync(
        join(result.value.backupPath, 'secrets.vault'),
        'utf-8',
      );
      expect(vaultContent).toBe('encrypted-secrets');
    }
  });

  it('should create the backup in the correct subdirectory', () => {
    createFakeDb(dataDir, 'meridian.db');

    const result = createPreUpdateBackup(dataDir, projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.backupPath).toContain('backups');
      expect(result.value.backupPath).toContain('pre-update-0.1.0');
    }
  });

  it('should succeed with zero files when no databases exist', () => {
    const result = createPreUpdateBackup(dataDir, projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileCount).toBe(0);
    }
  });

  it('should return error when data directory does not exist', () => {
    const result = createPreUpdateBackup('/nonexistent/path', projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not exist');
    }
  });

  it('should not back up non-database files', () => {
    createFakeDb(dataDir, 'meridian.db');
    writeFileSync(join(dataDir, 'config.toml'), 'some config');
    writeFileSync(join(dataDir, 'readme.txt'), 'notes');

    const result = createPreUpdateBackup(dataDir, projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const files = readdirSync(result.value.backupPath);
      expect(files).toContain('meridian.db');
      expect(files).not.toContain('config.toml');
      expect(files).not.toContain('readme.txt');
    }
  });
});

// ---------------------------------------------------------------------------
// findLatestBackup
// ---------------------------------------------------------------------------

describe('findLatestBackup', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    dataDir = join(tempDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should find the most recent backup', () => {
    const backupsDir = join(dataDir, 'backups');
    mkdirSync(join(backupsDir, 'pre-update-0.1.0-2026-01-01T10-00-00'), {
      recursive: true,
    });
    mkdirSync(join(backupsDir, 'pre-update-0.1.0-2026-02-15T12-30-00'), {
      recursive: true,
    });
    mkdirSync(join(backupsDir, 'pre-update-0.1.0-2026-01-15T08-00-00'), {
      recursive: true,
    });

    const result = findLatestBackup(dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timestamp).toBe('2026-02-15T12-30-00');
      expect(result.value.version).toBe('0.1.0');
    }
  });

  it('should ignore non-backup directories', () => {
    const backupsDir = join(dataDir, 'backups');
    mkdirSync(join(backupsDir, 'pre-update-0.1.0-2026-01-01T10-00-00'), {
      recursive: true,
    });
    mkdirSync(join(backupsDir, 'some-other-dir'), { recursive: true });
    writeFileSync(join(backupsDir, 'random-file.txt'), 'ignore me');

    const result = findLatestBackup(dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe('0.1.0');
    }
  });

  it('should return error when no backups directory exists', () => {
    const result = findLatestBackup(dataDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No backups directory found');
    }
  });

  it('should return error when no backup directories match the pattern', () => {
    const backupsDir = join(dataDir, 'backups');
    mkdirSync(join(backupsDir, 'unrelated-dir'), { recursive: true });

    const result = findLatestBackup(dataDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No pre-update backups found');
    }
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe('rollback', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    dataDir = join(tempDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should restore database files from the latest backup', () => {
    // Create current (corrupted/bad) database files
    createFakeDb(dataDir, 'meridian.db', 'corrupted-data');
    createFakeDb(dataDir, 'journal.db', 'corrupted-journal');

    // Create a backup with good data
    const backupDir = join(
      dataDir,
      'backups',
      'pre-update-0.1.0-2026-02-13T10-00-00',
    );
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'meridian.db'), 'good-data');
    writeFileSync(join(backupDir, 'journal.db'), 'good-journal');

    const result = rollback(dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileCount).toBe(2);
      expect(result.value.restoredVersion).toBe('0.1.0');

      // Verify restored content
      expect(readFileSync(join(dataDir, 'meridian.db'), 'utf-8')).toBe('good-data');
      expect(readFileSync(join(dataDir, 'journal.db'), 'utf-8')).toBe('good-journal');
    }
  });

  it('should restore secrets.vault from the backup', () => {
    writeFileSync(join(dataDir, 'secrets.vault'), 'new-vault');

    const backupDir = join(
      dataDir,
      'backups',
      'pre-update-0.1.0-2026-02-13T10-00-00',
    );
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'secrets.vault'), 'old-vault');

    const result = rollback(dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(readFileSync(join(dataDir, 'secrets.vault'), 'utf-8')).toBe('old-vault');
    }
  });

  it('should use the most recent backup when multiple exist', () => {
    // Older backup
    const olderBackup = join(
      dataDir,
      'backups',
      'pre-update-0.0.9-2026-01-01T10-00-00',
    );
    mkdirSync(olderBackup, { recursive: true });
    writeFileSync(join(olderBackup, 'meridian.db'), 'old-data');

    // Newer backup
    const newerBackup = join(
      dataDir,
      'backups',
      'pre-update-0.1.0-2026-02-13T10-00-00',
    );
    mkdirSync(newerBackup, { recursive: true });
    writeFileSync(join(newerBackup, 'meridian.db'), 'newer-data');

    const result = rollback(dataDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(readFileSync(join(dataDir, 'meridian.db'), 'utf-8')).toBe('newer-data');
      expect(result.value.restoredVersion).toBe('0.1.0');
    }
  });

  it('should return error when data directory does not exist', () => {
    const result = rollback('/nonexistent/path');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not exist');
    }
  });

  it('should return error when no backups exist', () => {
    const result = rollback(dataDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No backups directory found');
    }
  });

  it('should return error when backup directory is empty', () => {
    const backupDir = join(
      dataDir,
      'backups',
      'pre-update-0.1.0-2026-02-13T10-00-00',
    );
    mkdirSync(backupDir, { recursive: true });

    const result = rollback(dataDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('empty');
    }
  });
});

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

describe('runCli', () => {
  let tempDir: string;
  let dataDir: string;
  let projectRoot: string;
  let stdout: string[];
  let stderr: string[];
  let writeFn: (msg: string) => void;
  let writeErrFn: (msg: string) => void;

  beforeEach(() => {
    tempDir = createTempDir();
    dataDir = join(tempDir, 'data');
    projectRoot = join(tempDir, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    createPackageJson(projectRoot, '0.1.0');

    stdout = [];
    stderr = [];
    writeFn = (msg: string) => stdout.push(msg);
    writeErrFn = (msg: string) => stderr.push(msg);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should print usage for unknown commands', async () => {
    const code = await runCli(['unknown'], {
      projectRoot,
      dataDir,
      stdout: writeFn,
      stderr: writeErrFn,
    });

    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes('Unknown command'))).toBe(true);
    expect(stderr.some((l) => l.includes('Usage'))).toBe(true);
  });

  it('should print usage when no command is given', async () => {
    const code = await runCli([], {
      projectRoot,
      dataDir,
      stdout: writeFn,
      stderr: writeErrFn,
    });

    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes('Unknown command'))).toBe(true);
  });

  it('should exit 0 for successful rollback', async () => {
    // Set up a backup to rollback to
    const backupDir = join(
      dataDir,
      'backups',
      'pre-update-0.1.0-2026-02-13T10-00-00',
    );
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'meridian.db'), 'backup-data');

    const code = await runCli(['rollback'], {
      projectRoot,
      dataDir,
      stdout: writeFn,
      stderr: writeErrFn,
    });

    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes('Restored'))).toBe(true);
  });

  it('should exit 1 when rollback has no backups', async () => {
    const code = await runCli(['rollback'], {
      projectRoot,
      dataDir,
      stdout: writeFn,
      stderr: writeErrFn,
    });

    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes('Rollback failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

describe('UpdateError', () => {
  it('should extend MeridianError with ERR_UPDATE code', () => {
    const error = new UpdateError('update failed');
    expect(error.code).toBe('ERR_UPDATE');
    expect(error.name).toBe('UpdateError');
    expect(error.message).toBe('update failed');
  });

  it('should support Error cause', () => {
    const cause = new Error('root cause');
    const error = new UpdateError('wrapper', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('RollbackError', () => {
  it('should extend MeridianError with ERR_ROLLBACK code', () => {
    const error = new RollbackError('rollback failed');
    expect(error.code).toBe('ERR_ROLLBACK');
    expect(error.name).toBe('RollbackError');
    expect(error.message).toBe('rollback failed');
  });
});
