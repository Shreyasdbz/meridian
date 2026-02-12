// @meridian/gear — Gear runtime (Phase 5.3)
// Runs INSIDE the sandbox child process (forked by process-sandbox.ts).
//
// Responsibilities:
// 1. Read action requests from stdin (JSON, line-delimited)
// 2. Construct a GearContext proxy with manifest-enforced permissions
// 3. Load and execute the Gear code
// 4. Marshal results back to the host via stdout JSON
//
// Security enforcement:
// - Filesystem: paths canonicalized, checked against manifest read/write patterns
// - Network: domain allowlist, protocol validation, private IP filtering, DNS rebinding
// - Secrets: ACL from manifest permissions.secrets (not directory listing)
// - createSubJob: delegated to host via stdout message
//
// This file does NOT import from @meridian/* — the sandbox environment
// is restricted. Configuration comes from env vars set by process-sandbox.ts.

import { lookup as dnsLookup } from 'node:dns/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Types (self-contained — no external imports in sandbox)
// ---------------------------------------------------------------------------

interface RuntimeRequest {
  correlationId: string;
  action: string;
  parameters: Record<string, unknown>;
  hmac: string;
}

interface RuntimeResponse {
  correlationId: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  hmac: string;
}

interface ProgressMessage {
  type: 'progress';
  percent: number;
  message?: string;
}

interface LogMessage {
  type: 'log';
  gearId: string;
  message: string;
}

interface SubJobRequest {
  type: 'subjob';
  description: string;
  requestId: string;
}

/**
 * Manifest permissions structure (matches GearPermissions in shared/types.ts).
 * Duplicated here since the runtime cannot import from @meridian/shared.
 */
interface RuntimePermissions {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  network?: {
    domains?: string[];
    protocols?: string[];
  };
  secrets?: string[];
  shell?: boolean;
  environment?: string[];
}

/**
 * The GearContext proxy available to Gear code inside the sandbox.
 * Enforces manifest permissions for all operations.
 */
interface GearContextProxy {
  params: Record<string, unknown>;
  getSecret(name: string): Promise<string | undefined>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  fetch(url: string, options?: FetchOptions): Promise<FetchResponse>;
  log(message: string): void;
  progress(percent: number, message?: string): void;
  createSubJob(description: string): Promise<JobResult>;
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface JobResult {
  jobId: string;
  status: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retriable: boolean };
}

/**
 * A Gear module must export an `execute` function with this signature.
 */
interface GearModule {
  execute(context: GearContextProxy, action: string): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// HMAC signing
// Note: In v0.1, the child process does not have the HMAC signing key.
// Responses are sent with hmac: 'unsigned' and the host-side GearHost
// handles verification differently. In v0.2 with Ed25519 per-component
// key pairs, bidirectional signing will be enabled.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stdout helpers (line-delimited JSON)
// ---------------------------------------------------------------------------

function sendResponse(response: RuntimeResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendProgress(percent: number, message?: string): void {
  const msg: ProgressMessage = { type: 'progress', percent, message };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendLog(gearId: string, message: string): void {
  const msg: LogMessage = { type: 'log', gearId, message };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendSubJobRequest(description: string, requestId: string): void {
  const msg: SubJobRequest = { type: 'subjob', description, requestId };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ---------------------------------------------------------------------------
// Path validation (duplicated from context.ts for sandbox isolation)
// ---------------------------------------------------------------------------

/**
 * Validate a filesystem path against declared manifest patterns.
 * Prevents directory traversal and enforces read/write boundaries.
 */
function validatePath(
  requestedPath: string,
  allowedPatterns: string[] | undefined,
  workspacePath: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
  if (!allowedPatterns || allowedPatterns.length === 0) {
    return { ok: false, error: 'No filesystem permissions declared in manifest' };
  }

  const resolved = resolve(workspacePath, requestedPath);
  const normalizedWorkspace = resolve(workspacePath);

  // Must stay within workspace root (prevents traversal)
  if (!resolved.startsWith(normalizedWorkspace + sep) && resolved !== normalizedWorkspace) {
    return {
      ok: false,
      error: `Path '${requestedPath}' resolves outside workspace boundary`,
    };
  }

  // Check against allowed patterns
  const relativePath = relative(normalizedWorkspace, resolved);
  for (const pattern of allowedPatterns) {
    const prefix = pattern.replace(/\*\*\/?$/, '').replace(/\/$/, '');
    if (prefix === '') {
      return { ok: true, resolved };
    }
    if (relativePath.startsWith(prefix) || relativePath === prefix) {
      return { ok: true, resolved };
    }
  }

  return {
    ok: false,
    error: `Path '${requestedPath}' not covered by declared filesystem permissions`,
  };
}

// ---------------------------------------------------------------------------
// Network validation (duplicated from context.ts for sandbox isolation)
// ---------------------------------------------------------------------------

/** IPv4 private/reserved ranges per architecture Section 6.5. */
const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
];

/** Check if an IP address is in a private/reserved range. */
function isPrivateIp(ip: string): boolean {
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(ip)) return true;
  }
  if (ip === '::1') return true;
  if (/^fe80:/i.test(ip)) return true;
  if (ip.startsWith('::ffff:')) {
    return isPrivateIp(ip.slice(7));
  }
  return false;
}

/**
 * Validate URL against manifest network permissions.
 * Checks domain allowlist, protocol, and private IP ranges.
 */
function validateUrl(
  url: string,
  permissions: RuntimePermissions,
): { ok: true; parsed: URL } | { ok: false; error: string } {
  const allowedDomains = permissions.network?.domains;
  if (!allowedDomains || allowedDomains.length === 0) {
    return { ok: false, error: 'No network permissions declared in manifest' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }

  // Check protocol
  const allowedProtocols = permissions.network?.protocols ?? ['https'];
  const protocol = parsed.protocol.replace(':', '');
  if (!allowedProtocols.includes(protocol)) {
    return {
      ok: false,
      error: `Protocol '${protocol}' not allowed. Allowed: ${allowedProtocols.join(', ')}`,
    };
  }

  const hostname = parsed.hostname;

  // Block private IPs
  if (isPrivateIp(hostname)) {
    return {
      ok: false,
      error: `Private/reserved address '${hostname}' blocked for Gear network requests`,
    };
  }
  if (hostname === 'localhost') {
    return { ok: false, error: 'localhost blocked for Gear network requests' };
  }

  // Check domain against allowed list
  let domainAllowed = false;
  for (const allowed of allowedDomains) {
    if (allowed === '*') { domainAllowed = true; break; }
    if (hostname === allowed) { domainAllowed = true; break; }
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1);
      if (hostname.endsWith(suffix)) { domainAllowed = true; break; }
    }
  }

  if (!domainAllowed) {
    return {
      ok: false,
      error: `Domain '${hostname}' not in allowed domains: ${allowedDomains.join(', ')}`,
    };
  }

  return { ok: true, parsed };
}

/**
 * DNS rebinding prevention: resolve hostname and check resolved IPs.
 * Prevents a DNS record from resolving to private addresses after initial validation.
 */
async function checkDnsRebinding(
  hostname: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Skip for raw IP addresses
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return { ok: true };
  }

  try {
    const addresses = await dnsLookup(hostname, { all: true });
    for (const record of addresses) {
      if (isPrivateIp(record.address)) {
        return {
          ok: false,
          error: `DNS rebinding detected: '${hostname}' resolved to private IP '${record.address}'`,
        };
      }
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `DNS resolution failed for '${hostname}': ${String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// GearContext proxy construction
// ---------------------------------------------------------------------------

function createContextProxy(
  params: Record<string, unknown>,
  gearId: string,
  workspacePath: string,
  secretsDir: string | null,
  permissions: RuntimePermissions,
): GearContextProxy {
  const allowedSecrets = permissions.secrets ?? [];

  return {
    params: Object.freeze({ ...params }),

    getSecret(name: string): Promise<string | undefined> {
      if (!allowedSecrets.includes(name)) {
        return Promise.reject(new Error(
          `Secret '${name}' not declared in Gear '${gearId}' manifest permissions`,
        ));
      }
      if (!secretsDir) return Promise.resolve(undefined);
      try {
        return Promise.resolve(readFileSync(join(secretsDir, name), 'utf-8'));
      } catch {
        return Promise.resolve(undefined);
      }
    },

    readFile(path: string): Promise<Buffer> {
      const validation = validatePath(
        path,
        permissions.filesystem?.read,
        workspacePath,
      );
      if (!validation.ok) {
        return Promise.reject(new Error(
          `readFile denied for Gear '${gearId}': ${validation.error}`,
        ));
      }
      try {
        return Promise.resolve(readFileSync(validation.resolved));
      } catch (e) {
        return Promise.reject(new Error(
          `readFile failed for Gear '${gearId}': ${String(e)}`,
        ));
      }
    },

    async writeFile(path: string, content: Buffer): Promise<void> {
      const validation = validatePath(
        path,
        permissions.filesystem?.write,
        workspacePath,
      );
      if (!validation.ok) {
        throw new Error(
          `writeFile denied for Gear '${gearId}': ${validation.error}`,
        );
      }
      const { writeFile: fsWriteFile, mkdir } = await import('node:fs/promises');
      const parentDir = resolve(validation.resolved, '..');
      await mkdir(parentDir, { recursive: true });
      await fsWriteFile(validation.resolved, content);
    },

    async deleteFile(path: string): Promise<void> {
      const validation = validatePath(
        path,
        permissions.filesystem?.write,
        workspacePath,
      );
      if (!validation.ok) {
        throw new Error(
          `deleteFile denied for Gear '${gearId}': ${validation.error}`,
        );
      }
      const { unlink: fsUnlink } = await import('node:fs/promises');
      await fsUnlink(validation.resolved);
    },

    listFiles(dir: string): Promise<string[]> {
      const validation = validatePath(
        dir,
        permissions.filesystem?.read,
        workspacePath,
      );
      if (!validation.ok) {
        return Promise.reject(new Error(
          `listFiles denied for Gear '${gearId}': ${validation.error}`,
        ));
      }
      try {
        const entries = readdirSync(validation.resolved, { withFileTypes: true });
        return Promise.resolve(entries.map((entry) =>
          entry.isDirectory() ? `${entry.name}/` : entry.name,
        ));
      } catch (e) {
        return Promise.reject(new Error(
          `listFiles failed for Gear '${gearId}': ${String(e)}`,
        ));
      }
    },

    async fetch(url: string, options?: FetchOptions): Promise<FetchResponse> {
      // Validate URL against manifest permissions
      const urlValidation = validateUrl(url, permissions);
      if (!urlValidation.ok) {
        throw new Error(
          `fetch denied for Gear '${gearId}': ${urlValidation.error}`,
        );
      }

      // DNS rebinding prevention
      const dnsCheck = await checkDnsRebinding(urlValidation.parsed.hostname);
      if (!dnsCheck.ok) {
        throw new Error(
          `fetch denied for Gear '${gearId}': ${dnsCheck.error}`,
        );
      }

      // Execute the fetch
      const controller = new AbortController();
      const timeoutMs = options?.timeoutMs ?? 30_000;
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

      try {
        const response = await globalThis.fetch(urlValidation.parsed.toString(), {
          method: options?.method ?? 'GET',
          headers: options?.headers,
          body: options?.body ? String(options.body) : undefined,
          signal: controller.signal,
        });
        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: response.status, headers, body };
      } finally {
        clearTimeout(timer);
      }
    },

    log(message: string): void {
      sendLog(gearId, message);
    },

    progress(percent: number, message?: string): void {
      const clamped = Math.max(0, Math.min(100, percent));
      sendProgress(clamped, message);
    },

    createSubJob(description: string): Promise<JobResult> {
      // Sub-job creation is delegated to the host via stdout message.
      // The host routes it through the full Axis -> Scout -> Sentinel pipeline.
      // For v0.1, this sends a request and the host will respond asynchronously.
      // The promise resolution depends on the host sending back a result.
      const requestId = `subjob-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      sendSubJobRequest(description, requestId);

      // Note: In v0.1, sub-job creation from within the sandbox process
      // is fire-and-forget. The host receives the request and processes it.
      // Full request-response sub-job support will be added in v0.2
      // with bidirectional IPC messaging.
      return Promise.resolve({
        jobId: requestId,
        status: 'pending',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Permission parsing
// ---------------------------------------------------------------------------

/**
 * Parse manifest permissions from the MERIDIAN_GEAR_PERMISSIONS env variable.
 * Falls back to empty permissions (deny all) if parsing fails.
 */
function parsePermissions(): RuntimePermissions {
  const raw = process.env['MERIDIAN_GEAR_PERMISSIONS'];
  if (!raw) return {};

  try {
    return JSON.parse(raw) as RuntimePermissions;
  } catch {
    // If permissions can't be parsed, fail closed (deny all)
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main runtime loop
// ---------------------------------------------------------------------------

/**
 * Start the Gear runtime inside the sandbox process.
 *
 * Reads configuration from environment variables set by process-sandbox.ts:
 * - MERIDIAN_GEAR_ID: the Gear identifier
 * - MERIDIAN_WORKSPACE: path to the workspace directory
 * - MERIDIAN_SECRETS_DIR: path to the secrets tmpfs directory (optional)
 * - MERIDIAN_GEAR_PERMISSIONS: JSON-encoded manifest permissions
 */
export function startRuntime(): void {
  const gearId = process.env['MERIDIAN_GEAR_ID'] ?? 'unknown';
  const workspacePath = process.env['MERIDIAN_WORKSPACE'] ?? process.cwd();
  const secretsDir = process.env['MERIDIAN_SECRETS_DIR'] ?? null;
  const permissions = parsePermissions();

  let inputBuffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    inputBuffer += chunk;

    let newlineIdx: number;
    while ((newlineIdx = inputBuffer.indexOf('\n')) !== -1) {
      const line = inputBuffer.slice(0, newlineIdx).trim();
      inputBuffer = inputBuffer.slice(newlineIdx + 1);

      if (!line) continue;

      void processRequest(line, gearId, workspacePath, secretsDir, permissions);
    }
  });

  process.stdin.resume();
}

async function processRequest(
  line: string,
  gearId: string,
  workspacePath: string,
  secretsDir: string | null,
  permissions: RuntimePermissions,
): Promise<void> {
  let request: RuntimeRequest;

  try {
    request = JSON.parse(line) as RuntimeRequest;
  } catch {
    return;
  }

  const { correlationId, action, parameters } = request;

  try {
    // Note: In v0.1, HMAC verification in the runtime is skipped because
    // the signing key is not directly passed to the child process.
    // The host-side GearHost verifies response HMACs.
    // For v0.2, per-component Ed25519 keys will enable bidirectional verification.

    const context = createContextProxy(
      parameters,
      gearId,
      workspacePath,
      secretsDir,
      permissions,
    );

    // Load and execute the Gear module.
    // The Gear entry point is passed via MERIDIAN_GEAR_ENTRY_POINT env var
    // (set by buildSandboxEnv in process-sandbox.ts). Falls back to
    // process.argv[2] for direct invocation (e.g., testing).
    const entryPoint = process.env['MERIDIAN_GEAR_ENTRY_POINT'] ?? process.argv[2];
    if (!entryPoint) {
      sendResponse({
        correlationId,
        error: {
          code: 'RUNTIME_ERROR',
          message: 'No Gear entry point found. Set MERIDIAN_GEAR_ENTRY_POINT env var.',
        },
        hmac: 'unsigned',
      });
      return;
    }

    const gearModule = await import(entryPoint) as Partial<GearModule>;

    if (typeof gearModule.execute !== 'function') {
      sendResponse({
        correlationId,
        error: {
          code: 'GEAR_INVALID',
          message: `Gear '${gearId}' does not export an 'execute' function`,
        },
        hmac: 'unsigned',
      });
      return;
    }

    const result = await gearModule.execute(context, action);

    // Note: For v0.1, the child doesn't have the signing key.
    // The response is sent unsigned. In v0.2, Ed25519 key pairs enable signing.
    sendResponse({
      correlationId,
      result,
      hmac: 'unsigned',
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    sendResponse({
      correlationId,
      error: { code: 'GEAR_ERROR', message: errorMessage },
      hmac: 'unsigned',
    });
  }
}

// Auto-start when this file is the entry point
const isMainModule = typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('gear-runtime.js');

if (isMainModule) {
  startRuntime();
}
