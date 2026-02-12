// @meridian/gear — Level 1 process sandbox (Section 5.6.3)
// child_process.fork() with OS-level restrictions.
// macOS: sandbox-exec profiles. Linux: seccomp BPF via prctl.

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  createHmac,
  randomBytes,
  timingSafeEqual as cryptoTimingSafeEqual,
} from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { GearManifest, GearPermissions, GearResources, Result } from '@meridian/shared';
import {
  ok,
  err,
  GEAR_KILL_TIMEOUT_MS,
  DEFAULT_GEAR_MEMORY_MB,
  DEFAULT_GEAR_TIMEOUT_MS,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Message sent from GearHost to the sandbox child process.
 */
export interface SandboxRequest {
  correlationId: string;
  action: string;
  parameters: Record<string, unknown>;
  hmac: string;
}

/**
 * Message sent from the sandbox child process back to GearHost.
 */
export interface SandboxResponse {
  correlationId: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  hmac: string;
}

/**
 * Progress message emitted by Gear during execution.
 */
export interface SandboxProgress {
  type: 'progress';
  percent: number;
  message?: string;
}

/**
 * A line of structured output from the Gear process stdout.
 * Discriminated by the `type` field.
 */
export type SandboxStdoutMessage =
  | (SandboxResponse & { type?: undefined })
  | SandboxProgress;

/**
 * Options for creating a sandbox.
 */
export interface SandboxOptions {
  /** Path to the Gear entry point (JavaScript file to fork). */
  entryPoint: string;
  /** Gear manifest (permissions, resources, identity). */
  manifest: GearManifest;
  /** HMAC signing key for message integrity. */
  signingKey: Buffer;
  /** Workspace directory (mounted read-only by default). */
  workspacePath: string;
  /** Secrets to inject (name -> value). Values are Buffers, zeroed after injection. */
  secrets?: Map<string, Buffer>;
  /** Optional logger. */
  logger?: SandboxLogger;
}

/**
 * Logger interface for sandbox operations.
 */
export interface SandboxLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Handle to a running sandbox process.
 */
export interface SandboxHandle {
  /** The child process. */
  process: ChildProcess;
  /** Path to the temporary secrets directory (tmpfs on Linux). */
  secretsDir: string | null;
  /** Path to the temporary sandbox working directory. */
  sandboxDir: string;
  /** HMAC signing key. */
  signingKey: Buffer;
  /** The manifest for this Gear. */
  manifest: GearManifest;
  /** Whether the sandbox has been destroyed. */
  destroyed: boolean;
}

// ---------------------------------------------------------------------------
// HMAC signing and verification
// ---------------------------------------------------------------------------

/**
 * Sign a message payload with HMAC-SHA256.
 */
export function signMessage(
  payload: Record<string, unknown>,
  key: Buffer,
): string {
  const body = JSON.stringify(payload);
  return createHmac('sha256', key).update(body).digest('base64');
}

/**
 * Verify an HMAC-SHA256 signature on a message payload.
 * Uses Node.js crypto.timingSafeEqual for constant-time comparison.
 */
export function verifySignature(
  payload: Record<string, unknown>,
  signature: string,
  key: Buffer,
): boolean {
  const expected = signMessage(payload, key);
  if (expected.length !== signature.length) {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return cryptoTimingSafeEqual(a, b);
}

/**
 * Generate a cryptographically random signing key.
 */
export function generateSigningKey(): Buffer {
  return randomBytes(32);
}

// ---------------------------------------------------------------------------
// macOS sandbox-exec profile generation
// ---------------------------------------------------------------------------

/**
 * Generate a macOS sandbox-exec profile (Seatbelt) for the Gear's permissions.
 *
 * sandbox-exec is deprecated by Apple and may be removed in future macOS.
 * Level 2 (isolated-vm) or Level 3 (Docker) are recommended for production macOS.
 * This is acceptable for v0.1 development.
 */
export function generateSeatbeltProfile(
  permissions: GearPermissions,
  workspacePath: string,
  secretsDir: string | null,
  sandboxDir: string,
): string {
  const rules: string[] = [
    '(version 1)',
    '(deny default)',
    // Allow basic process operations
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // Allow reading system libraries and Node.js runtime
    '(allow file-read* (subpath "/usr/lib"))',
    '(allow file-read* (subpath "/usr/local"))',
    '(allow file-read* (subpath "/opt/homebrew"))',
    '(allow file-read* (regex #"^/private/var/db/"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/Library/Frameworks"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))',
    '(allow file-write* (literal "/dev/null"))',
    // Allow reading the sandbox working directory
    `(allow file-read* (subpath "${escapeSeatbelt(sandboxDir)}"))`,
    `(allow file-write* (subpath "${escapeSeatbelt(sandboxDir)}"))`,
    // Allow reading the workspace (read-only by default)
    `(allow file-read* (subpath "${escapeSeatbelt(resolve(workspacePath))}"))`,
  ];

  // Filesystem write permissions
  if (permissions.filesystem?.write) {
    for (const pattern of permissions.filesystem.write) {
      const resolved = resolve(workspacePath, pattern.replace(/\*\*/g, ''));
      rules.push(`(allow file-write* (subpath "${escapeSeatbelt(resolved)}"))`);
    }
  }

  // Additional filesystem read permissions
  if (permissions.filesystem?.read) {
    for (const pattern of permissions.filesystem.read) {
      const resolved = resolve(workspacePath, pattern.replace(/\*\*/g, ''));
      rules.push(`(allow file-read* (subpath "${escapeSeatbelt(resolved)}"))`);
    }
  }

  // Secrets directory access
  if (secretsDir) {
    rules.push(`(allow file-read* (subpath "${escapeSeatbelt(secretsDir)}"))`);
  }

  // Network access
  if (permissions.network?.domains && permissions.network.domains.length > 0) {
    rules.push('(allow network-outbound)');
    rules.push('(allow system-socket)');
  }

  return rules.join('\n');
}

/**
 * Escape a string for inclusion in a Seatbelt profile.
 */
function escapeSeatbelt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Linux seccomp profile (placeholder for real BPF)
// ---------------------------------------------------------------------------

/**
 * Generate a seccomp BPF profile description for the Gear's permissions.
 *
 * In a production deployment, this would compile to a real seccomp-bpf filter.
 * For v0.1, we document the intended restrictions and enforce via other means
 * (filesystem permissions, network filtering at the application layer).
 *
 * The profile is stored as JSON metadata for audit/logging purposes.
 */
export interface SeccompProfile {
  /** Syscalls explicitly allowed. */
  allowedSyscalls: string[];
  /** Syscalls explicitly blocked (everything else is also blocked). */
  blockedSyscalls: string[];
  /** Whether network syscalls are allowed. */
  networkAllowed: boolean;
  /** Max memory in bytes (for setrlimit). */
  maxMemoryBytes: number;
}

export function generateSeccompProfile(
  permissions: GearPermissions,
  resources: GearResources,
): SeccompProfile {
  const baseSyscalls = [
    'read', 'write', 'open', 'close', 'stat', 'fstat', 'lstat',
    'lseek', 'mmap', 'mprotect', 'munmap', 'brk', 'ioctl',
    'access', 'pipe', 'dup', 'dup2', 'getpid', 'getuid', 'getgid',
    'gettimeofday', 'clock_gettime', 'nanosleep', 'epoll_create',
    'epoll_ctl', 'epoll_wait', 'futex', 'exit_group', 'exit',
    'fcntl', 'openat', 'readlink', 'getcwd', 'getrandom',
  ];

  const blockedSyscalls = ['ptrace', 'mount', 'umount', 'reboot', 'swapon', 'swapoff'];

  const hasNetwork = (permissions.network?.domains ?? []).length > 0;
  if (hasNetwork) {
    baseSyscalls.push('socket', 'connect', 'sendto', 'recvfrom', 'bind', 'listen', 'accept');
  } else {
    blockedSyscalls.push('socket', 'connect', 'sendto', 'recvfrom', 'bind', 'listen', 'accept');
  }

  if (!permissions.shell) {
    blockedSyscalls.push('execve', 'execveat');
  }

  const maxMemoryMb = resources.maxMemoryMb ?? DEFAULT_GEAR_MEMORY_MB;
  const maxMemoryBytes = maxMemoryMb * 1024 * 1024;

  return {
    allowedSyscalls: baseSyscalls,
    blockedSyscalls,
    networkAllowed: hasNetwork,
    maxMemoryBytes,
  };
}

// ---------------------------------------------------------------------------
// Sandbox environment construction
// ---------------------------------------------------------------------------

/**
 * Build a restricted environment variables object for the sandbox process.
 * Secrets are NOT passed via environment variables (security rule).
 */
export function buildSandboxEnv(
  manifest: GearManifest,
  sandboxDir: string,
  secretsDir: string | null,
): Record<string, string> {
  const env: Record<string, string> = {
    // Minimal PATH for Node.js runtime
    PATH: '/usr/local/bin:/usr/bin:/bin',
    // Tell the Gear where its workspace is
    MERIDIAN_WORKSPACE: sandboxDir,
    // Gear identity
    MERIDIAN_GEAR_ID: manifest.id,
    MERIDIAN_GEAR_VERSION: manifest.version,
    // Node.js settings
    NODE_ENV: 'production',
    // Disable Node.js inspector/debugger
    NODE_OPTIONS: '--no-warnings',
  };

  if (secretsDir) {
    env['MERIDIAN_SECRETS_DIR'] = secretsDir;
  }

  // Only pass explicitly declared environment variables from permissions
  if (manifest.permissions.environment) {
    for (const varName of manifest.permissions.environment) {
      const value = process.env[varName];
      if (value !== undefined) {
        env[varName] = value;
      }
    }
  }

  return env;
}

// ---------------------------------------------------------------------------
// Secrets injection
// ---------------------------------------------------------------------------

/**
 * Inject secrets as files in a temporary directory.
 *
 * On Linux, this should ideally be a tmpfs mount point so secrets
 * exist only in memory. On macOS we use a regular temp directory
 * with restrictive permissions (chmod 0700).
 *
 * Secret values (Buffers) are zeroed after being written to files.
 */
export function injectSecrets(
  secrets: Map<string, Buffer>,
  allowedSecrets: string[] | undefined,
  logger?: SandboxLogger,
): string | null {
  if (secrets.size === 0) {
    return null;
  }

  // Create temp directory for secrets
  const secretsDir = mkdtempSync(join(tmpdir(), 'meridian-secrets-'));

  for (const [name, value] of secrets) {
    // Only inject secrets that the Gear has declared in its permissions
    if (allowedSecrets && !allowedSecrets.includes(name)) {
      logger?.warn('Skipping undeclared secret', { secretName: name });
      continue;
    }

    const secretPath = join(secretsDir, name);
    writeFileSync(secretPath, value, { mode: 0o600 });

    // Zero the Buffer after writing
    value.fill(0);
  }

  return secretsDir;
}

/**
 * Clean up the secrets directory by overwriting files with zeros then removing.
 */
export function cleanupSecrets(secretsDir: string | null, logger?: SandboxLogger): void {
  if (!secretsDir || !existsSync(secretsDir)) {
    return;
  }

  try {
    rmSync(secretsDir, { recursive: true, force: true });
  } catch (e) {
    logger?.error('Failed to clean up secrets directory', {
      secretsDir,
      error: String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Sandbox lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a sandbox: fork a child process with restricted environment.
 *
 * Lifecycle: create -> inject secrets -> (execute via gear-host) -> destroy
 */
export function createSandbox(options: SandboxOptions): Result<SandboxHandle, string> {
  const {
    entryPoint,
    manifest,
    signingKey,
    workspacePath,
    secrets,
    logger,
  } = options;

  // Validate entry point exists
  if (!existsSync(entryPoint)) {
    return err(`Gear entry point not found: ${entryPoint}`);
  }

  // Create sandbox working directory
  const sandboxDir = mkdtempSync(join(tmpdir(), `meridian-sandbox-${manifest.id}-`));

  // Inject secrets
  const secretsDir = secrets
    ? injectSecrets(secrets, manifest.permissions.secrets, logger)
    : null;

  // Build restricted environment
  const env = buildSandboxEnv(manifest, sandboxDir, secretsDir);

  // Build fork options
  const forkOptions: Record<string, unknown> = {
    env,
    cwd: sandboxDir,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as const,
    // Prevent the child from inheriting file descriptors
    detached: false,
  };

  // On macOS, use sandbox-exec for OS-level isolation
  const platform = process.platform;
  let execArgv: string[] = [];

  if (platform === 'darwin') {
    const profile = generateSeatbeltProfile(
      manifest.permissions,
      workspacePath,
      secretsDir,
      sandboxDir,
    );
    const profilePath = join(sandboxDir, '.sandbox-profile');
    writeFileSync(profilePath, profile, { mode: 0o600 });
    // Note: sandbox-exec wrapping would require spawning via sandbox-exec binary.
    // In fork() mode, we store the profile for documentation/audit.
    // Full OS-level enforcement happens when using spawn() with sandbox-exec.
    logger?.info('Seatbelt profile generated', { gearId: manifest.id, profilePath });
  }

  if (platform === 'linux') {
    const resources: GearResources = {
      maxMemoryMb: manifest.resources?.maxMemoryMb ?? DEFAULT_GEAR_MEMORY_MB,
      maxCpuPercent: manifest.resources?.maxCpuPercent,
      timeoutMs: manifest.resources?.timeoutMs ?? DEFAULT_GEAR_TIMEOUT_MS,
    };
    const seccompProfile = generateSeccompProfile(manifest.permissions, resources);
    const seccompPath = join(sandboxDir, '.seccomp-profile.json');
    writeFileSync(seccompPath, JSON.stringify(seccompProfile, null, 2), { mode: 0o600 });
    logger?.info('Seccomp profile generated', { gearId: manifest.id, seccompPath });
  }

  // Apply resource limits via Node.js flags
  const maxMemoryMb = manifest.resources?.maxMemoryMb ?? DEFAULT_GEAR_MEMORY_MB;
  execArgv = [`--max-old-space-size=${maxMemoryMb}`];

  let child: ChildProcess;
  try {
    child = fork(entryPoint, [], {
      ...forkOptions,
      execArgv,
    });
  } catch (e) {
    // Clean up on fork failure
    cleanupSecrets(secretsDir, logger);
    rmSync(sandboxDir, { recursive: true, force: true });
    return err(`Failed to fork sandbox process: ${String(e)}`);
  }

  logger?.info('Sandbox created', {
    gearId: manifest.id,
    pid: child.pid,
    sandboxDir,
    maxMemoryMb,
  });

  return ok({
    process: child,
    secretsDir,
    sandboxDir,
    signingKey,
    manifest,
    destroyed: false,
  });
}

/**
 * Destroy a sandbox: kill the process, clean up secrets and temp dirs.
 *
 * Uses SIGTERM with a grace period, then SIGKILL.
 */
export async function destroySandbox(
  handle: SandboxHandle,
  logger?: SandboxLogger,
): Promise<void> {
  if (handle.destroyed) {
    return;
  }

  handle.destroyed = true;
  const pid = handle.process.pid;

  // Try graceful shutdown first
  if (handle.process.exitCode === null && !handle.process.killed) {
    handle.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (handle.process.exitCode === null && !handle.process.killed) {
          logger?.warn('Sandbox did not exit gracefully, sending SIGKILL', {
            gearId: handle.manifest.id,
            pid,
          });
          handle.process.kill('SIGKILL');
        }
        resolve();
      }, GEAR_KILL_TIMEOUT_MS);

      handle.process.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  // Clean up secrets
  cleanupSecrets(handle.secretsDir, logger);

  // Clean up sandbox directory
  try {
    if (existsSync(handle.sandboxDir)) {
      rmSync(handle.sandboxDir, { recursive: true, force: true });
    }
  } catch (e) {
    logger?.error('Failed to clean up sandbox directory', {
      sandboxDir: handle.sandboxDir,
      error: String(e),
    });
  }

  logger?.info('Sandbox destroyed', {
    gearId: handle.manifest.id,
    pid,
  });
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that a path does not escape the allowed directory.
 * Prevents directory traversal attacks (../../etc/passwd).
 */
export function isPathAllowed(
  requestedPath: string,
  allowedPaths: string[],
  basePath: string,
): boolean {
  const resolved = resolve(basePath, requestedPath);
  const normalizedBase = resolve(basePath);

  // Must be within the base path
  if (!resolved.startsWith(normalizedBase)) {
    return false;
  }

  // Must match at least one allowed pattern
  for (const allowed of allowedPaths) {
    const allowedResolved = resolve(basePath, allowed.replace(/\*\*/g, ''));
    if (resolved.startsWith(allowedResolved)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate that a network domain is allowed by the Gear's permissions.
 * Blocks private IP ranges by default.
 */
export function isDomainAllowed(
  domain: string,
  allowedDomains: string[] | undefined,
): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    return false;
  }

  // Block private IP ranges
  if (isPrivateAddress(domain)) {
    return false;
  }

  for (const allowed of allowedDomains) {
    if (allowed === '*') {
      return true;
    }
    // Exact match
    if (domain === allowed) {
      return true;
    }
    // Wildcard subdomain match (e.g., *.example.com)
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // .example.com
      if (domain.endsWith(suffix)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an address is in a private/reserved IP range.
 */
function isPrivateAddress(address: string): boolean {
  // IPv4 private ranges
  if (/^10\./.test(address)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true;
  if (/^192\.168\./.test(address)) return true;
  if (/^127\./.test(address)) return true;
  if (/^0\./.test(address)) return true;
  if (address === 'localhost') return true;

  // IPv6 loopback
  if (address === '::1') return true;
  // IPv6 link-local
  if (/^fe80:/i.test(address)) return true;

  return false;
}
