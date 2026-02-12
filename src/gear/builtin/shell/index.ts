// @meridian/gear/builtin/shell — Shell command execution (Phase 5.6)
//
// Built-in Gear for running shell commands with special hardening.
// Disabled by default — must be explicitly enabled by user.
// Exempt from Sentinel Memory auto-approval — every execution requires
// fresh user approval.
//
// Hardening (Section 5.6.5):
//   - Disabled by default: enforced at registry level during registration
//   - Exempt from Sentinel Memory auto-approval: enforced at approval level
//   - No parameter interpolation: command string is executed as-is
//   - Output size limit enforcement: large output saved to workspace file
//   - Timeout enforcement: child_process timeout + SIGKILL fallback
//
// Architecture references:
//   - Section 5.6.2 (Gear Manifest)
//   - Section 5.6.5 (Shell Gear hardening)
//   - Section 9.3 (GearContext API)
//   - Section 5.6.3 (GearHost provenance)
//   - Implementation Plan Phase 5.6

import { exec as execCb } from 'node:child_process';

import type { GearContext } from '@meridian/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default command timeout: 30 seconds */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum allowed timeout: 5 minutes */
const MAX_TIMEOUT_MS = 300_000;

/** Minimum allowed timeout: 1 second */
const MIN_TIMEOUT_MS = 1_000;

/** Default maximum output size before writing to file: 1 MB */
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Hard cap on buffered output from child_process.exec: 10 MB */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Preview size when output is written to file: 8 KB */
const OUTPUT_PREVIEW_BYTES = 8_192;

/** Grace period before SIGKILL after timeout: 5 seconds */
const KILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Parameter extraction helpers
// ---------------------------------------------------------------------------

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Parameter "${name}" is required and must be a non-empty string`);
  }
  return value;
}

function optionalNumber(
  params: Record<string, unknown>,
  name: string,
  defaultValue: number,
): number {
  const value = params[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number') {
    throw new Error(`Parameter "${name}" must be a number`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

/**
 * Execute a shell command with timeout enforcement.
 *
 * Security: The command string is passed to /bin/sh -c (via child_process.exec).
 * No parameter interpolation occurs — the command is executed exactly as
 * provided. Security relies on:
 * 1. The Gear being disabled by default
 * 2. Every execution requiring fresh user approval (exempt from auto-approval)
 * 3. Sandbox isolation (Seatbelt/seccomp restricts what the shell can access)
 */
function execCommand(command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execCb(
      command,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        killSignal: 'SIGTERM',
      },
      (error, stdout, stderr) => {
        const stdoutStr = typeof stdout === 'string' ? stdout : String(stdout);
        const stderrStr = typeof stderr === 'string' ? stderr : String(stderr);

        if (error) {
          resolve({
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode: typeof error.code === 'number' ? error.code : null,
            signal: error.signal ?? null,
            timedOut: error.killed === true,
          });
        } else {
          resolve({
            stdout: stdoutStr,
            stderr: stderrStr,
            exitCode: 0,
            signal: null,
            timedOut: false,
          });
        }
      },
    );

    // Safety: force kill if the process doesn't die within timeout + grace period
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, timeoutMs + KILL_GRACE_MS);

    child.on('close', () => {
      clearTimeout(killTimer);
    });
  });
}

// ---------------------------------------------------------------------------
// Output size enforcement
// ---------------------------------------------------------------------------

/**
 * If output exceeds maxOutputBytes, write full output to a workspace file
 * and return a truncated preview with a file reference.
 */
async function enforceOutputSize(
  context: GearContext,
  output: string,
  label: string,
  maxOutputBytes: number,
): Promise<{ text: string; file: string | null }> {
  const byteLength = Buffer.byteLength(output, 'utf-8');

  if (byteLength <= maxOutputBytes) {
    return { text: output, file: null };
  }

  // Write full output to workspace file
  const timestamp = Date.now();
  const filePath = `shell-output/${label}-${timestamp}.txt`;
  await context.writeFile(filePath, Buffer.from(output, 'utf-8'));

  // Return truncated preview
  const previewBytes = Math.min(OUTPUT_PREVIEW_BYTES, maxOutputBytes);
  const previewBuffer = Buffer.from(output, 'utf-8').subarray(0, previewBytes);
  const preview = previewBuffer.toString('utf-8');
  const truncated =
    `${preview}\n\n` +
    `[Output truncated: ${byteLength} bytes total. ` +
    `Full output saved to ${filePath}]`;

  return { text: truncated, file: filePath };
}

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

/**
 * Execute a shell command and return stdout, stderr, exit code.
 *
 * Hardening:
 * - No parameter interpolation: command is a single string, executed as-is
 * - Timeout enforcement via child_process timeout + SIGKILL fallback
 * - Output size limiting with workspace file fallback
 * - Command is logged for audit trail
 */
async function executeAction(
  context: GearContext,
): Promise<Record<string, unknown>> {
  const command = requireString(context.params, 'command');
  const rawTimeout = optionalNumber(context.params, 'timeoutMs', DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = optionalNumber(
    context.params,
    'maxOutputBytes',
    DEFAULT_MAX_OUTPUT_BYTES,
  );

  // Clamp timeout to safe range
  const timeoutMs = Math.min(Math.max(rawTimeout, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);

  context.log(`Executing shell command: ${command}`);

  const executedAt = new Date().toISOString();
  const result = await execCommand(command, timeoutMs);

  // Enforce output size limits
  const stdoutResult = await enforceOutputSize(
    context,
    result.stdout,
    'stdout',
    maxOutputBytes,
  );
  const stderrResult = await enforceOutputSize(
    context,
    result.stderr,
    'stderr',
    maxOutputBytes,
  );

  if (result.timedOut) {
    context.log(`Command timed out after ${timeoutMs}ms`);
  } else {
    context.log(`Command exited with code ${result.exitCode}`);
  }

  // Build output — required fields always present, optional fields only when set
  const output: Record<string, unknown> = {
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    command,
    executedAt,
  };

  if (result.signal !== null) {
    output['signal'] = result.signal;
  }
  if (stdoutResult.file !== null) {
    output['stdoutFile'] = stdoutResult.file;
  }
  if (stderrResult.file !== null) {
    output['stderrFile'] = stderrResult.file;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Gear entry point
// ---------------------------------------------------------------------------

/**
 * Execute a shell Gear action.
 *
 * This is the standard Gear entry point called by gear-runtime.ts.
 * The shell Gear has special hardening requirements:
 * - Disabled by default (enforced at registry level)
 * - Exempt from Sentinel Memory auto-approval (enforced at approval level)
 * - No parameter interpolation into commands
 * - Output size limits with workspace file fallback
 * - Timeout enforcement
 *
 * @param context - The constrained GearContext with action parameters
 * @param action - The action name to execute
 * @returns Action result with stdout, stderr, exit code
 */
export async function execute(
  context: GearContext,
  action: string,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'execute':
      return executeAction(context);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
