// @meridian/gear — Container sandbox (Level 3 — Docker) (Phase 10.4)
//
// Provides Docker-based isolation for Gear execution.
// Features: read-only root FS, no network, memory/CPU/pids limits,
// tmpfs for secrets, read-only workspace mount.
// Communication via JSON stdin/stdout piped through docker exec.
// Auto-destroys container after completion.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GearManifest } from '@meridian/shared';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerSandboxOptions {
  /** Gear manifest for permissions and resource limits. */
  manifest: GearManifest;
  /** Path to workspace directory to mount (read-only). */
  workspacePath: string;
  /** Docker image to use. Defaults to 'node:20-slim'. */
  image?: string;
  /** Memory limit (e.g., '256m'). */
  memoryLimit?: string;
  /** CPU quota (e.g., '0.5' for half a core). */
  cpuLimit?: string;
  /** Max number of processes inside container. */
  pidsLimit?: number;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Logger. */
  logger?: ContainerSandboxLogger;
}

export interface ContainerSandboxLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface ContainerHandle {
  containerId: string;
  manifest: GearManifest;
  destroyed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = 'node:20-slim';
const DEFAULT_MEMORY_LIMIT = '256m';
const DEFAULT_CPU_LIMIT = '0.5';
const DEFAULT_PIDS_LIMIT = 64;
const DEFAULT_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

let dockerAvailableCache: boolean | undefined;

/**
 * Check if Docker is available on the system.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== undefined) {
    return dockerAvailableCache;
  }

  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 });
    dockerAvailableCache = true;
    return true;
  } catch {
    dockerAvailableCache = false;
    return false;
  }
}

/**
 * Reset the Docker availability cache (for testing).
 */
export function resetDockerCache(): void {
  dockerAvailableCache = undefined;
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Build the Docker run arguments for a container sandbox.
 */
export function buildDockerArgs(options: ContainerSandboxOptions): string[] {
  const {
    manifest,
    workspacePath,
    image = DEFAULT_IMAGE,
    memoryLimit = DEFAULT_MEMORY_LIMIT,
    cpuLimit = DEFAULT_CPU_LIMIT,
    pidsLimit = DEFAULT_PIDS_LIMIT,
  } = options;

  const args: string[] = [
    'run',
    '--rm',
    '-d', // detached
    '--read-only', // read-only root FS
    '--network=none', // no network access
    `--memory=${memoryLimit}`,
    `--cpus=${cpuLimit}`,
    `--pids-limit=${String(pidsLimit)}`,
    '--tmpfs=/tmp:rw,noexec,nosuid,size=64m', // writable /tmp
    '--tmpfs=/secrets:rw,noexec,nosuid,size=1m', // tmpfs for secrets
    `-v=${workspacePath}:/workspace:ro`, // read-only workspace
    '--security-opt=no-new-privileges',
    `--name=meridian-gear-${manifest.id}-${Date.now()}`,
    image,
    'tail', '-f', '/dev/null', // keep container running
  ];

  return args;
}

/**
 * Create a container sandbox.
 */
export async function createContainerSandbox(
  options: ContainerSandboxOptions,
): Promise<ContainerHandle> {
  const logger = options.logger;

  const available = await isDockerAvailable();
  if (!available) {
    throw new Error('Docker is not available. Cannot create container sandbox.');
  }

  const args = buildDockerArgs(options);

  logger?.debug('Creating container sandbox', {
    gearId: options.manifest.id,
    image: options.image ?? DEFAULT_IMAGE,
  });

  const { stdout } = await execFileAsync('docker', args, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const containerId = stdout.trim();

  logger?.info('Container sandbox created', {
    containerId,
    gearId: options.manifest.id,
  });

  return {
    containerId,
    manifest: options.manifest,
    destroyed: false,
  };
}

/**
 * Destroy a container sandbox.
 */
export async function destroyContainerSandbox(
  handle: ContainerHandle,
  logger?: ContainerSandboxLogger,
): Promise<void> {
  if (handle.destroyed) {
    return;
  }

  try {
    await execFileAsync('docker', ['rm', '-f', handle.containerId], {
      timeout: 10000,
    });
    handle.destroyed = true;
    logger?.info('Container sandbox destroyed', {
      containerId: handle.containerId,
    });
  } catch (error) {
    logger?.error('Failed to destroy container sandbox', {
      containerId: handle.containerId,
      error: error instanceof Error ? error.message : String(error),
    });
    handle.destroyed = true; // Mark as destroyed to prevent retries
  }
}

/**
 * Execute a command inside a container sandbox.
 */
export async function execInContainer(
  handle: ContainerHandle,
  command: string[],
  options?: { timeout?: number; logger?: ContainerSandboxLogger },
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  const { stdout, stderr } = await execFileAsync(
    'docker',
    ['exec', handle.containerId, ...command],
    { timeout },
  );

  return { stdout, stderr };
}

/**
 * Get resource usage stats for a running container.
 */
export async function getContainerStats(
  handle: ContainerHandle,
): Promise<{ memoryUsageMb: number; cpuPercent: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.MemUsage}}\t{{.CPUPerc}}', handle.containerId],
      { timeout: 5000 },
    );

    const parts = stdout.trim().split('\t');
    if (parts.length < 2) return null;

    const memPart = parts[0];
    const memStr = memPart ? memPart.split('/')[0]?.trim() ?? '' : '';
    const memMb = parseMemoryString(memStr);
    const cpuPart = parts[1];
    const cpuPercent = cpuPart ? parseFloat(cpuPart.replace('%', '')) : 0;

    return { memoryUsageMb: memMb, cpuPercent };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMemoryString(mem: string): number {
  const lower = mem.toLowerCase();
  if (lower.endsWith('gib')) {
    return parseFloat(lower) * 1024;
  }
  if (lower.endsWith('mib')) {
    return parseFloat(lower);
  }
  if (lower.endsWith('kib')) {
    return parseFloat(lower) / 1024;
  }
  return parseFloat(lower);
}
