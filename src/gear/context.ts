// @meridian/gear — GearContext implementation (Phase 5.3, Section 9.3)
// The constrained API available to Gear code inside the sandbox.
// Enforces filesystem, network, and secret ACL boundaries per manifest.

import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

import type {
  FetchOptions,
  FetchResponse,
  GearManifest,
  GearPermissions,
  JobResult,
  Result,
} from '@meridian/shared';
import { ok, err, GearSandboxError, SecretAccessError } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback for retrieving a secret by name from the vault.
 * Returns the decrypted secret value, or undefined if not found.
 */
export type SecretProvider = (
  gearId: string,
  secretName: string,
) => Promise<string | undefined>;

/**
 * Callback for creating a sub-job through Axis.
 * Routes through the full Scout -> Sentinel -> Gear pipeline.
 */
export type SubJobCreator = (description: string) => Promise<JobResult>;

/**
 * Callback for appending to the execution log.
 */
export type LogSink = (gearId: string, message: string) => void;

/**
 * Callback for reporting progress to Bridge UI.
 */
export type ProgressSink = (percent: number, message?: string) => void;

/**
 * Configuration for creating a GearContext instance.
 */
export interface GearContextConfig {
  /** The Gear manifest (drives permission enforcement). */
  manifest: GearManifest;
  /** Parameters passed to the current action. */
  params: Record<string, unknown>;
  /** Base path for workspace filesystem operations. */
  workspacePath: string;
  /** Callback to retrieve secrets from the vault. */
  getSecret?: SecretProvider;
  /** Callback to create sub-jobs through Axis. */
  createSubJob?: SubJobCreator;
  /** Callback for execution log entries. */
  onLog?: LogSink;
  /** Callback for progress updates. */
  onProgress?: ProgressSink;
}

// ---------------------------------------------------------------------------
// Private IP detection (for DNS rebinding prevention)
// ---------------------------------------------------------------------------

/** IPv4 private/reserved ranges per architecture Section 6.5. */
const PRIVATE_IPV4_PATTERNS = [
  /^10\./,           // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./,     // 192.168.0.0/16
  /^127\./,          // 127.0.0.0/8 (loopback)
  /^0\./,            // 0.0.0.0/8
  /^169\.254\./,     // 169.254.0.0/16 (link-local)
];

/**
 * Check if an IP address is in a private/reserved range.
 * Covers IPv4 private ranges, IPv6 loopback, and link-local.
 */
export function isPrivateIp(ip: string): boolean {
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(ip)) return true;
  }
  // IPv6 loopback
  if (ip === '::1') return true;
  // IPv6 link-local
  if (/^fe80:/i.test(ip)) return true;
  // IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) {
    const v4Part = ip.slice(7);
    return isPrivateIp(v4Part);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Canonicalize and validate a filesystem path against the manifest's declared paths.
 * Prevents directory traversal and enforces read/write boundaries.
 *
 * @param requestedPath - The path requested by the Gear
 * @param allowedPatterns - Glob patterns from the manifest (e.g., ['data/workspace/**'])
 * @param workspacePath - Absolute path to the workspace root
 * @returns Resolved absolute path if allowed, or an error message
 */
export function validatePath(
  requestedPath: string,
  allowedPatterns: string[] | undefined,
  workspacePath: string,
): Result<string, string> {
  if (!allowedPatterns || allowedPatterns.length === 0) {
    return err('No filesystem permissions declared in manifest');
  }

  // Resolve to absolute path within workspace
  const resolved = resolve(workspacePath, requestedPath);
  const normalizedWorkspace = resolve(workspacePath);

  // Must stay within workspace root (prevents traversal)
  if (!resolved.startsWith(normalizedWorkspace + sep) && resolved !== normalizedWorkspace) {
    return err(
      `Path '${requestedPath}' resolves outside workspace boundary`,
    );
  }

  // Check against allowed patterns
  const relativePath = relative(normalizedWorkspace, resolved);
  for (const pattern of allowedPatterns) {
    // Strip trailing ** for prefix matching
    const prefix = pattern.replace(/\*\*\/?$/, '').replace(/\/$/, '');
    if (prefix === '') {
      // Pattern like '**' — allows everything within workspace
      return ok(resolved);
    }
    if (relativePath.startsWith(prefix) || relativePath === prefix) {
      return ok(resolved);
    }
  }

  return err(
    `Path '${requestedPath}' not covered by declared filesystem permissions`,
  );
}

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

/**
 * Validate that a URL's domain is allowed by the manifest and not a private address.
 *
 * @param url - The URL to validate
 * @param permissions - The Gear's network permissions
 * @returns The parsed URL if allowed, or an error message
 */
export function validateUrl(
  url: string,
  permissions: GearPermissions,
): Result<URL, string> {
  const allowedDomains = permissions.network?.domains;
  if (!allowedDomains || allowedDomains.length === 0) {
    return err('No network permissions declared in manifest');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err(`Invalid URL: ${url}`);
  }

  // Check protocol
  const allowedProtocols = permissions.network?.protocols ?? ['https'];
  const protocol = parsed.protocol.replace(':', '');
  if (!allowedProtocols.includes(protocol)) {
    return err(
      `Protocol '${protocol}' not allowed. Allowed: ${allowedProtocols.join(', ')}`,
    );
  }

  const hostname = parsed.hostname;

  // Block private IPs at the domain level (before DNS)
  if (isPrivateIp(hostname)) {
    return err(
      `Private/reserved address '${hostname}' blocked for Gear network requests`,
    );
  }
  if (hostname === 'localhost') {
    return err('localhost blocked for Gear network requests');
  }

  // Check domain against allowed list
  let domainAllowed = false;
  for (const allowed of allowedDomains) {
    if (allowed === '*') {
      domainAllowed = true;
      break;
    }
    if (hostname === allowed) {
      domainAllowed = true;
      break;
    }
    // Wildcard subdomain match (e.g., *.example.com)
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // .example.com
      if (hostname.endsWith(suffix)) {
        domainAllowed = true;
        break;
      }
    }
  }

  if (!domainAllowed) {
    return err(
      `Domain '${hostname}' not in allowed domains: ${allowedDomains.join(', ')}`,
    );
  }

  return ok(parsed);
}

/**
 * DNS resolver function signature for dependency injection.
 */
export type DnsResolver = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

/** Default DNS resolver using Node.js dns/promises. */
const defaultDnsResolver: DnsResolver = async (hostname, options) => {
  const result = await dnsLookup(hostname, options);
  return result as Array<{ address: string; family: number }>;
};

/**
 * Resolve a hostname via DNS and verify the resolved IPs are not private.
 * Prevents DNS rebinding attacks (Section 6.5).
 *
 * @param hostname - The hostname to resolve
 * @param resolver - Optional DNS resolver for testing
 */
export async function checkDnsRebinding(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver,
): Promise<Result<void, string>> {
  // Skip DNS check for IP addresses (already checked by isPrivateIp)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return ok(undefined);
  }

  try {
    const addresses = await resolver(hostname, { all: true });
    for (const record of addresses) {
      if (isPrivateIp(record.address)) {
        return err(
          `DNS rebinding detected: '${hostname}' resolved to private IP '${record.address}'`,
        );
      }
    }
    return ok(undefined);
  } catch (e) {
    return err(`DNS resolution failed for '${hostname}': ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// GearContextImpl
// ---------------------------------------------------------------------------

/**
 * Implementation of the GearContext interface (Section 9.3).
 *
 * This is the **only** API surface available to Gear code. It enforces:
 * - Filesystem access boundaries (read/write paths from manifest)
 * - Network access boundaries (domains from manifest, private IP filtering)
 * - DNS rebinding prevention (resolved IPs checked against private ranges)
 * - Secret ACL (only manifest-declared secrets accessible)
 * - Sub-job routing through Axis (full Scout -> Sentinel -> Gear pipeline)
 */
export class GearContextImpl {
  readonly params: Record<string, unknown>;

  private readonly manifest: GearManifest;
  private readonly workspacePath: string;
  private readonly secretProvider?: SecretProvider;
  private readonly subJobCreator?: SubJobCreator;
  private readonly logSink?: LogSink;
  private readonly progressSink?: ProgressSink;

  constructor(config: GearContextConfig) {
    this.params = Object.freeze({ ...config.params });
    this.manifest = config.manifest;
    this.workspacePath = resolve(config.workspacePath);
    this.secretProvider = config.getSecret;
    this.subJobCreator = config.createSubJob;
    this.logSink = config.onLog;
    this.progressSink = config.onProgress;
  }

  /**
   * Read an allowed secret by name.
   * Only secrets declared in the manifest's permissions.secrets ACL are accessible.
   */
  async getSecret(name: string): Promise<string | undefined> {
    const allowedSecrets = this.manifest.permissions.secrets;
    if (!allowedSecrets || !allowedSecrets.includes(name)) {
      throw new SecretAccessError(
        `Secret '${name}' not declared in Gear '${this.manifest.id}' manifest permissions`,
      );
    }

    if (!this.secretProvider) {
      return undefined;
    }

    return this.secretProvider(this.manifest.id, name);
  }

  /**
   * Read a file within the declared filesystem read paths.
   */
  async readFile(path: string): Promise<Buffer> {
    const validation = validatePath(
      path,
      this.manifest.permissions.filesystem?.read,
      this.workspacePath,
    );
    if (!validation.ok) {
      throw new GearSandboxError(
        `readFile denied for Gear '${this.manifest.id}': ${validation.error}`,
      );
    }

    return readFile(validation.value);
  }

  /**
   * Write a file within the declared filesystem write paths.
   * Creates parent directories if they don't exist.
   */
  async writeFile(path: string, content: Buffer): Promise<void> {
    const validation = validatePath(
      path,
      this.manifest.permissions.filesystem?.write,
      this.workspacePath,
    );
    if (!validation.ok) {
      throw new GearSandboxError(
        `writeFile denied for Gear '${this.manifest.id}': ${validation.error}`,
      );
    }

    // Create parent directories
    const parentDir = resolve(validation.value, '..');
    await mkdir(parentDir, { recursive: true });

    await writeFile(validation.value, content);
  }

  /**
   * List files in a directory within the declared filesystem read paths.
   */
  async listFiles(dir: string): Promise<string[]> {
    const validation = validatePath(
      dir,
      this.manifest.permissions.filesystem?.read,
      this.workspacePath,
    );
    if (!validation.ok) {
      throw new GearSandboxError(
        `listFiles denied for Gear '${this.manifest.id}': ${validation.error}`,
      );
    }

    const entries = await readdir(validation.value, { withFileTypes: true });
    return entries.map((entry) =>
      entry.isDirectory() ? `${entry.name}/` : entry.name,
    );
  }

  /**
   * Make a network request to an allowed domain.
   * Enforces domain allowlist, private IP filtering, and DNS rebinding prevention.
   */
  async fetch(url: string, options?: FetchOptions): Promise<FetchResponse> {
    // Validate URL against manifest permissions
    const urlValidation = validateUrl(url, this.manifest.permissions);
    if (!urlValidation.ok) {
      throw new GearSandboxError(
        `fetch denied for Gear '${this.manifest.id}': ${urlValidation.error}`,
      );
    }

    const parsedUrl = urlValidation.value;

    // DNS rebinding prevention: resolve hostname and check IPs
    const dnsCheck = await checkDnsRebinding(parsedUrl.hostname);
    if (!dnsCheck.ok) {
      throw new GearSandboxError(
        `fetch denied for Gear '${this.manifest.id}': ${dnsCheck.error}`,
      );
    }

    // Execute the fetch using Node.js built-in fetch
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

    try {
      const response = await globalThis.fetch(parsedUrl.toString(), {
        method: options?.method ?? 'GET',
        headers: options?.headers,
        body: options?.body ? String(options.body) : undefined,
        signal: controller.signal,
      });

      const body = await response.text();

      // Convert response headers to plain object
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return { status: response.status, headers, body };
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new GearSandboxError(
          `fetch timed out after ${timeoutMs}ms for Gear '${this.manifest.id}'`,
        );
      }
      throw new GearSandboxError(
        `fetch failed for Gear '${this.manifest.id}': ${String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Append a message to the execution log.
   */
  log(message: string): void {
    this.logSink?.(this.manifest.id, message);
  }

  /**
   * Update the progress for Bridge UI.
   * @param percent - Progress percentage (0-100)
   * @param message - Optional human-readable status message
   */
  progress(percent: number, message?: string): void {
    const clamped = Math.max(0, Math.min(100, percent));
    this.progressSink?.(clamped, message);
  }

  /**
   * Spawn a sub-task that goes through the full Axis -> Scout -> Sentinel pipeline.
   */
  async createSubJob(description: string): Promise<JobResult> {
    if (!this.subJobCreator) {
      throw new GearSandboxError(
        `createSubJob not available for Gear '${this.manifest.id}': no sub-job creator configured`,
      );
    }

    return this.subJobCreator(description);
  }
}

/**
 * Create a GearContext for use by a Gear action.
 * This is the factory function called by the GearHost before executing a Gear.
 */
export function createGearContext(config: GearContextConfig): GearContextImpl {
  return new GearContextImpl(config);
}
