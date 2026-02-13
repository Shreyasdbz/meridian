// @meridian/cli — Update mechanism (Section 10.5)
//
// User-initiated update checking, backup, installation, and rollback.
// No automatic update checks. No telemetry. No version reporting.
// The only network request is a single GET to the GitHub Releases API.

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { createLogger, MeridianError, ok, err } from '@meridian/shared';
import type { Result } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_REPO = 'meridian-ai/meridian';
const GITHUB_RELEASES_URL =
  `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const BACKUP_SUBDIR = 'backups';

/** SQLite database file extensions to back up. */
const DB_EXTENSIONS = ['.db', '.db-wal', '.db-shm'];

/** Pattern for pre-update backup directories. */
const BACKUP_DIR_PATTERN = /^pre-update-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/;

const logger = createLogger({ context: { component: 'cli:update' } });

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class UpdateError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_UPDATE', message, options);
    this.name = 'UpdateError';
  }
}

export class RollbackError extends MeridianError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERR_ROLLBACK', message, options);
    this.name = 'RollbackError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  readonly releaseUrl: string;
  readonly releaseNotes: string;
}

export interface BackupResult {
  readonly backupPath: string;
  readonly version: string;
  readonly timestamp: string;
  readonly fileCount: number;
}

export interface UpdateResult {
  readonly previousVersion: string;
  readonly newVersion: string;
  readonly backupPath: string;
}

export interface RollbackResult {
  readonly restoredFrom: string;
  readonly restoredVersion: string;
  readonly fileCount: number;
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}

/**
 * Parse a semver string (e.g., "0.1.0", "1.2.3-beta.1") into components.
 * Strips a leading 'v' if present.
 */
function parseSemVer(version: string): SemVer | undefined {
  const cleaned = version.startsWith('v') ? version.slice(1) : version;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(cleaned);
  if (!match) {
    return undefined;
  }
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    prerelease: match[4] ?? '',
  };
}

/**
 * Compare two semver versions.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Pre-release versions are considered lower than the same version without pre-release.
 */
export function compareSemVer(a: string, b: string): number {
  const parsedA = parseSemVer(a);
  const parsedB = parseSemVer(b);

  if (!parsedA || !parsedB) {
    return a.localeCompare(b);
  }

  const majorDiff = parsedA.major - parsedB.major;
  if (majorDiff !== 0) return majorDiff;

  const minorDiff = parsedA.minor - parsedB.minor;
  if (minorDiff !== 0) return minorDiff;

  const patchDiff = parsedA.patch - parsedB.patch;
  if (patchDiff !== 0) return patchDiff;

  // Both have no pre-release: equal
  if (!parsedA.prerelease && !parsedB.prerelease) return 0;

  // Pre-release has lower precedence than release
  if (parsedA.prerelease && !parsedB.prerelease) return -1;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;

  // Both have pre-release: lexicographic comparison
  return parsedA.prerelease.localeCompare(parsedB.prerelease);
}

// ---------------------------------------------------------------------------
// Read current version from package.json
// ---------------------------------------------------------------------------

/**
 * Read the current Meridian version from package.json.
 */
export function getCurrentVersion(projectRoot: string): string {
  const packagePath = join(projectRoot, 'package.json');
  if (!existsSync(packagePath)) {
    throw new UpdateError(`package.json not found at ${packagePath}`);
  }

  const raw = readFileSync(packagePath, 'utf-8');
  const parsed = JSON.parse(raw) as { version?: string };

  if (!parsed.version) {
    throw new UpdateError('No version field found in package.json');
  }

  return parsed.version;
}

// ---------------------------------------------------------------------------
// GitHub API interaction
// ---------------------------------------------------------------------------

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body: string;
}

/**
 * Fetch the latest release from GitHub.
 *
 * Makes a single GET request to the GitHub Releases API.
 * No telemetry, no version reporting, no identifying headers beyond
 * User-Agent (required by GitHub API).
 */
async function fetchLatestRelease(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<GitHubRelease, string>> {
  try {
    const response = await fetchFn(GITHUB_RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'meridian-update-check',
      },
    });

    if (response.status === 404) {
      return err('No releases found for this repository');
    }

    if (response.status === 403) {
      return err('GitHub API rate limit exceeded. Try again later.');
    }

    if (!response.ok) {
      return err(`GitHub API returned status ${response.status}`);
    }

    const data = (await response.json()) as GitHubRelease;

    if (!data.tag_name) {
      return err('Invalid release data: missing tag_name');
    }

    return ok(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to fetch latest release: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check for available updates.
 *
 * Reads the current version from package.json and queries the GitHub
 * Releases API for the latest version. No telemetry — just the HTTP
 * request itself.
 */
export async function checkForUpdates(
  projectRoot: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<UpdateCheckResult, string>> {
  const currentVersion = getCurrentVersion(projectRoot);

  const releaseResult = await fetchLatestRelease(fetchFn);
  if (!releaseResult.ok) {
    return err(releaseResult.error);
  }

  const release = releaseResult.value;
  const latestVersion = release.tag_name.startsWith('v')
    ? release.tag_name.slice(1)
    : release.tag_name;

  const updateAvailable = compareSemVer(currentVersion, latestVersion) < 0;

  return ok({
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseUrl: release.html_url,
    releaseNotes: typeof release.body === 'string' ? release.body : '',
  });
}

/**
 * Create a pre-update backup of all SQLite databases in the data directory.
 *
 * Backs up to `{dataDir}/backups/pre-update-{version}-{timestamp}/`.
 * Includes all .db, .db-wal, and .db-shm files.
 */
export function createPreUpdateBackup(
  dataDir: string,
  projectRoot: string,
): Result<BackupResult, string> {
  if (!existsSync(dataDir)) {
    return err(`Data directory does not exist: ${dataDir}`);
  }

  const version = getCurrentVersion(projectRoot);
  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);

  const backupDirName = `pre-update-${version}-${timestamp}`;
  const backupPath = join(dataDir, BACKUP_SUBDIR, backupDirName);

  try {
    mkdirSync(backupPath, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to create backup directory: ${message}`);
  }

  // Find all database files in the data directory
  let files: string[];
  try {
    files = readdirSync(dataDir).filter((f) =>
      DB_EXTENSIONS.some((ext) => f.endsWith(ext)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to read data directory: ${message}`);
  }

  if (files.length === 0) {
    logger.warn('No database files found in data directory', { dataDir });
  }

  let fileCount = 0;
  for (const file of files) {
    const srcPath = join(dataDir, file);
    const destPath = join(backupPath, file);

    try {
      copyFileSync(srcPath, destPath);
      fileCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to back up ${file}: ${message}`);
    }
  }

  // Also back up the secrets vault if present
  const vaultPath = join(dataDir, 'secrets.vault');
  if (existsSync(vaultPath)) {
    try {
      copyFileSync(vaultPath, join(backupPath, 'secrets.vault'));
      fileCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to back up secrets vault: ${message}`);
    }
  }

  logger.info('Pre-update backup created', {
    backupPath,
    version,
    fileCount,
  });

  return ok({
    backupPath,
    version,
    timestamp,
    fileCount,
  });
}

/**
 * Apply an update to Meridian.
 *
 * v0.1 approach: Backs up data, then runs `npm install` to update
 * dependencies. For git-cloned installations, the user should `git pull`
 * before running this command. Future versions will support npm-based
 * distribution with automatic code updates.
 *
 * Steps:
 * 1. Create a pre-update backup of databases.
 * 2. Run `npm install` to update dependencies.
 * 3. Database migrations run automatically on next start (Section 10.5).
 *
 * Returns a Result indicating success or failure.
 */
export function applyUpdate(
  dataDir: string,
  projectRoot: string,
): Result<UpdateResult, string> {
  const previousVersion = getCurrentVersion(projectRoot);

  // Step 1: Create pre-update backup
  const backupResult = createPreUpdateBackup(dataDir, projectRoot);
  if (!backupResult.ok) {
    return err(`Backup failed: ${backupResult.error}`);
  }

  logger.info('Pre-update backup complete', {
    backupPath: backupResult.value.backupPath,
  });

  // Step 2: Run npm install
  try {
    execSync('npm install', {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 300_000, // 5 minutes
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`npm install failed: ${message}`);
  }

  // Read the (potentially new) version after update
  const newVersion = getCurrentVersion(projectRoot);

  logger.info('Update applied', {
    previousVersion,
    newVersion,
    backupPath: backupResult.value.backupPath,
  });

  return ok({
    previousVersion,
    newVersion,
    backupPath: backupResult.value.backupPath,
  });
}

/**
 * Find the most recent pre-update backup in the data directory.
 */
export function findLatestBackup(
  dataDir: string,
): Result<{ path: string; version: string; timestamp: string }, string> {
  const backupsDir = join(dataDir, BACKUP_SUBDIR);

  if (!existsSync(backupsDir)) {
    return err('No backups directory found');
  }

  let entries: string[];
  try {
    entries = readdirSync(backupsDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to read backups directory: ${message}`);
  }

  // Filter to pre-update backup directories and sort by timestamp (descending)
  const backups = entries
    .map((name) => {
      const match = BACKUP_DIR_PATTERN.exec(name);
      if (!match) return undefined;
      const dirPath = join(backupsDir, name);
      try {
        const stat = statSync(dirPath);
        if (!stat.isDirectory()) return undefined;
      } catch {
        return undefined;
      }
      const version = match[1];
      const timestamp = match[2];
      if (!version || !timestamp) return undefined;
      return {
        name,
        path: dirPath,
        version,
        timestamp,
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== undefined)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const latest = backups[0];
  if (!latest) {
    return err('No pre-update backups found');
  }

  return ok({
    path: latest.path,
    version: latest.version,
    timestamp: latest.timestamp,
  });
}

/**
 * Rollback to the most recent pre-update backup.
 *
 * Finds the latest backup in `{dataDir}/backups/` and restores all
 * database files and the secrets vault from it.
 */
export function rollback(dataDir: string): Result<RollbackResult, string> {
  if (!existsSync(dataDir)) {
    return err(`Data directory does not exist: ${dataDir}`);
  }

  const backupResult = findLatestBackup(dataDir);
  if (!backupResult.ok) {
    return err(backupResult.error);
  }

  const backup = backupResult.value;
  const backupPath = backup.path;

  // Read backup files
  let backupFiles: string[];
  try {
    backupFiles = readdirSync(backupPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to read backup directory: ${message}`);
  }

  if (backupFiles.length === 0) {
    return err(`Backup directory is empty: ${backupPath}`);
  }

  // Restore each file
  let fileCount = 0;
  for (const file of backupFiles) {
    const srcPath = join(backupPath, file);
    const destPath = join(dataDir, file);

    try {
      copyFileSync(srcPath, destPath);
      fileCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to restore ${file}: ${message}`);
    }
  }

  logger.info('Rollback complete', {
    restoredFrom: backupPath,
    restoredVersion: backup.version,
    fileCount,
  });

  return ok({
    restoredFrom: backupPath,
    restoredVersion: backup.version,
    fileCount,
  });
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

/**
 * Run the update CLI with the given arguments.
 *
 * Commands:
 *   update --check   Check for available updates
 *   update           Apply the latest update
 *   rollback         Revert to the previous backup
 */
export async function runCli(
  args: string[],
  options?: {
    projectRoot?: string;
    dataDir?: string;
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
  },
): Promise<number> {
  const projectRoot = options?.projectRoot ?? resolve(process.cwd());
  const dataDir = options?.dataDir ?? join(projectRoot, 'data');
  const write = options?.stdout ?? ((msg: string) => process.stdout.write(msg + '\n'));
  const writeErr = options?.stderr ?? ((msg: string) => process.stderr.write(msg + '\n'));

  const command = args[0];
  const flags = args.slice(1);

  if (command === 'update') {
    if (flags.includes('--check')) {
      return await runCheckForUpdates(projectRoot, write, writeErr);
    }
    return runApplyUpdate(dataDir, projectRoot, write, writeErr);
  }

  if (command === 'rollback') {
    return runRollback(dataDir, write, writeErr);
  }

  writeErr(`Unknown command: ${command ?? '(none)'}`);
  writeErr('Usage:');
  writeErr('  meridian update --check   Check for available updates');
  writeErr('  meridian update           Apply the latest update');
  writeErr('  meridian rollback         Revert to the previous backup');
  return 1;
}

async function runCheckForUpdates(
  projectRoot: string,
  write: (msg: string) => void,
  writeErr: (msg: string) => void,
): Promise<number> {
  const result = await checkForUpdates(projectRoot);

  if (!result.ok) {
    writeErr(`Error checking for updates: ${result.error}`);
    return 1;
  }

  const {
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseUrl,
    releaseNotes,
  } = result.value;

  write(`Current version: ${currentVersion}`);
  write(`Latest version:  ${latestVersion}`);

  if (updateAvailable) {
    write('');
    write('An update is available!');
    write(`Release: ${releaseUrl}`);
    if (releaseNotes) {
      write('');
      write('Release notes:');
      write(releaseNotes);
    }
    write('');
    write('Run `meridian update` to install.');
  } else {
    write('');
    write('You are running the latest version.');
  }

  return 0;
}

function runApplyUpdate(
  dataDir: string,
  projectRoot: string,
  write: (msg: string) => void,
  writeErr: (msg: string) => void,
): number {
  write('Starting update...');

  const result = applyUpdate(dataDir, projectRoot);

  if (!result.ok) {
    writeErr(`Update failed: ${result.error}`);
    writeErr('Your data has been backed up. Run `meridian rollback` to restore.');
    return 1;
  }

  const { previousVersion, newVersion, backupPath } = result.value;

  write(`Updated: ${previousVersion} -> ${newVersion}`);
  write(`Backup saved to: ${backupPath}`);
  write('');
  write('Database migrations will run automatically on next start.');
  write('Restart Meridian to complete the update.');

  return 0;
}

function runRollback(
  dataDir: string,
  write: (msg: string) => void,
  writeErr: (msg: string) => void,
): number {
  write('Starting rollback...');

  const result = rollback(dataDir);

  if (!result.ok) {
    writeErr(`Rollback failed: ${result.error}`);
    return 1;
  }

  const { restoredFrom, restoredVersion, fileCount } = result.value;

  write(`Restored ${fileCount} file(s) from version ${restoredVersion}`);
  write(`Backup used: ${restoredFrom}`);
  write('');
  write('Restart Meridian to complete the rollback.');

  return 0;
}
