// @meridian/gear/builtin/shell — Unit tests (Phase 5.6)
//
// Tests for the shell built-in Gear:
// - Manifest validation (id, origin, risk level, permissions)
// - Command execution with stdout/stderr capture
// - Disabled-by-default properties (critical risk, shell permission)
// - Timeout enforcement
// - Output size limiting with workspace file fallback
// - Parameter validation and error handling
//
// Note: Execution-level _provenance tagging is handled by GearHost
// (Section 5.6.3) and tested in gear-host.test.ts.
//
// Architecture references:
//   - Section 5.6.2 (Gear Manifest)
//   - Section 5.6.5 (Shell Gear hardening)
//   - Section 9.3 (GearContext API)
//   - Implementation Plan Phase 5.6

import { describe, it, expect, vi } from 'vitest';

import type { GearContext, FetchResponse } from '@meridian/shared';

import manifest from './manifest.json';

import { execute } from './index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock GearContext for testing the shell Gear.
 * writeFile is mocked to succeed (needed for large output tests).
 */
function createTestContext(
  params: Record<string, unknown> = {},
  overrides?: Partial<GearContext>,
): GearContext {
  return {
    params,

    getSecret(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },

    readFile(): Promise<Buffer> {
      return Promise.reject(new Error('readFile not available in shell tests'));
    },

    writeFile: vi.fn((): Promise<void> => Promise.resolve()),

    deleteFile(): Promise<void> {
      return Promise.reject(new Error('deleteFile not available in shell tests'));
    },

    listFiles(): Promise<string[]> {
      return Promise.reject(new Error('listFiles not available in shell tests'));
    },

    fetch(): Promise<FetchResponse> {
      return Promise.reject(new Error('fetch not available in shell tests'));
    },

    log: vi.fn(),

    progress: vi.fn(),

    createSubJob(): Promise<never> {
      return Promise.reject(new Error('createSubJob not available in shell tests'));
    },

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shell Gear', () => {
  // -------------------------------------------------------------------------
  // Manifest validation
  // -------------------------------------------------------------------------

  describe('manifest', () => {
    it('should have correct id and origin', () => {
      expect(manifest.id).toBe('shell');
      expect(manifest.origin).toBe('builtin');
    });

    it('should define a single execute action', () => {
      expect(manifest.actions).toHaveLength(1);
      const actionNames = manifest.actions.map((a) => a.name);
      expect(actionNames).toEqual(['execute']);
    });

    it('should have critical risk level for the execute action', () => {
      for (const action of manifest.actions) {
        expect(action.riskLevel).toBe('critical');
      }
    });

    it('should declare shell permission', () => {
      expect(manifest.permissions.shell).toBe(true);
    });

    it('should declare filesystem write for output files only', () => {
      const fs = manifest.permissions.filesystem;
      expect(fs).toBeDefined();
      expect(fs.write).toEqual(['shell-output/**']);
      expect(
        (fs as Record<string, unknown>)['read'],
      ).toBeUndefined();
    });

    it('should not declare network permissions', () => {
      expect(
        (manifest.permissions as Record<string, unknown>)['network'],
      ).toBeUndefined();
    });

    it('should have resource limits', () => {
      expect(manifest.resources.maxMemoryMb).toBe(256);
      expect(manifest.resources.maxCpuPercent).toBe(50);
      expect(manifest.resources.timeoutMs).toBe(300000);
    });

    it('should require command parameter', () => {
      const action = manifest.actions.find((a) => a.name === 'execute');
      expect(action).toBeDefined();
      const params = action?.parameters as Record<string, unknown>;
      expect(params['required']).toEqual(['command']);
    });
  });

  // -------------------------------------------------------------------------
  // Command execution
  // -------------------------------------------------------------------------

  describe('execute action', () => {
    it('should execute a command and return stdout', async () => {
      const context = createTestContext({ command: 'echo hello' });

      const result = await execute(context, 'execute');

      expect(result['stdout']).toBe('hello\n');
      expect(result['exitCode']).toBe(0);
      expect(result['timedOut']).toBe(false);
    });

    it('should capture stderr separately', async () => {
      const context = createTestContext({ command: 'echo error >&2' });

      const result = await execute(context, 'execute');

      expect(result['stderr']).toBe('error\n');
      expect(result['stdout']).toBe('');
      expect(result['exitCode']).toBe(0);
    });

    it('should capture both stdout and stderr', async () => {
      const context = createTestContext({
        command: 'echo out && echo err >&2',
      });

      const result = await execute(context, 'execute');

      expect(result['stdout']).toBe('out\n');
      expect(result['stderr']).toBe('err\n');
    });

    it('should return non-zero exit code for failed commands', async () => {
      const context = createTestContext({ command: 'exit 42' });

      const result = await execute(context, 'execute');

      expect(result['exitCode']).toBe(42);
      expect(result['timedOut']).toBe(false);
    });

    it('should include command and executedAt in output', async () => {
      const context = createTestContext({ command: 'echo test' });
      const before = new Date().toISOString();

      const result = await execute(context, 'execute');

      const after = new Date().toISOString();
      expect(result['command']).toBe('echo test');
      expect(typeof result['executedAt']).toBe('string');

      // Timestamp should be between before and after
      const ts = result['executedAt'] as string;
      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    });

    it('should not include signal when process exits normally', async () => {
      const context = createTestContext({ command: 'echo ok' });

      const result = await execute(context, 'execute');

      expect(result['signal']).toBeUndefined();
    });

    it('should not include stdoutFile when output is within limit', async () => {
      const context = createTestContext({ command: 'echo small' });

      const result = await execute(context, 'execute');

      expect(result['stdoutFile']).toBeUndefined();
      expect(result['stderrFile']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Disabled by default
  // -------------------------------------------------------------------------

  describe('disabled by default', () => {
    it('should have critical risk level that flags it for disabled-by-default', () => {
      // Critical risk level + shell permission signals to the registry
      // that this Gear must be explicitly enabled by the user
      for (const action of manifest.actions) {
        expect(action.riskLevel).toBe('critical');
      }
      expect(manifest.permissions.shell).toBe(true);
    });

    it('should document disabled-by-default in description', () => {
      expect(manifest.description).toContain('Disabled by default');
    });

    it('should document approval exemption in description', () => {
      expect(manifest.description).toContain(
        'exempt from Sentinel Memory auto-approval',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Timeout enforcement
  // -------------------------------------------------------------------------

  describe('timeout enforcement', () => {
    it('should kill long-running commands and set timedOut flag', async () => {
      const context = createTestContext({
        command: 'sleep 100',
        timeoutMs: 500,
      });

      const result = await execute(context, 'execute');

      expect(result['timedOut']).toBe(true);
      expect(result['exitCode']).toBe(null);
    }, 15_000);

    it('should clamp timeout to minimum of 1 second', async () => {
      // Even with a tiny timeout, the command should still execute
      const context = createTestContext({
        command: 'echo fast',
        timeoutMs: 1, // Will be clamped to 1000ms
      });

      const result = await execute(context, 'execute');

      // The command is fast enough to complete within 1 second
      expect(result['stdout']).toBe('fast\n');
      expect(result['exitCode']).toBe(0);
    });

    it('should clamp timeout to maximum of 5 minutes', async () => {
      // A huge timeout should be clamped to MAX_TIMEOUT_MS
      const context = createTestContext({
        command: 'echo ok',
        timeoutMs: 999_999_999,
      });

      const result = await execute(context, 'execute');

      expect(result['exitCode']).toBe(0);
    });

    it('should log timeout event', async () => {
      const logSpy = vi.fn();
      const context = createTestContext(
        { command: 'sleep 100', timeoutMs: 500 },
        { log: logSpy },
      );

      await execute(context, 'execute');

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('timed out'),
      );
    }, 15_000);
  });

  // -------------------------------------------------------------------------
  // Output size limiting
  // -------------------------------------------------------------------------

  describe('output size limiting', () => {
    it('should return output inline when within limit', async () => {
      const context = createTestContext({
        command: 'echo small output',
        maxOutputBytes: 1000,
      });

      const result = await execute(context, 'execute');

      expect(result['stdout']).toBe('small output\n');
      expect(result['stdoutFile']).toBeUndefined();
    });

    it('should write large stdout to workspace file', async () => {
      // Generate output larger than maxOutputBytes
      const writeFileSpy = vi.fn((): Promise<void> => Promise.resolve());
      const context = createTestContext(
        {
          command: `${process.execPath} -e "process.stdout.write('x'.repeat(5000))"`,
          maxOutputBytes: 1000,
        },
        { writeFile: writeFileSpy },
      );

      const result = await execute(context, 'execute');

      // writeFile should have been called
      expect(writeFileSpy).toHaveBeenCalled();

      // stdoutFile reference should be present
      expect(result['stdoutFile']).toBeDefined();
      expect(typeof result['stdoutFile']).toBe('string');
      expect((result['stdoutFile'] as string)).toContain('shell-output/stdout-');

      // stdout should contain a truncated preview
      expect(result['stdout']).toContain('[Output truncated:');
      expect(result['stdout']).toContain('5000 bytes total');
    }, 15_000);

    it('should write large stderr to workspace file', async () => {
      const writeFileSpy = vi.fn((): Promise<void> => Promise.resolve());
      const context = createTestContext(
        {
          command: `${process.execPath} -e "process.stderr.write('e'.repeat(3000))"`,
          maxOutputBytes: 500,
        },
        { writeFile: writeFileSpy },
      );

      const result = await execute(context, 'execute');

      expect(writeFileSpy).toHaveBeenCalled();
      expect(result['stderrFile']).toBeDefined();
      expect((result['stderrFile'] as string)).toContain('shell-output/stderr-');
      expect(result['stderr']).toContain('[Output truncated:');
    }, 15_000);

    it('should include preview text when output is truncated', async () => {
      const context = createTestContext({
        command: `${process.execPath} -e "process.stdout.write('PREVIEW_START_' + 'x'.repeat(5000))"`,
        maxOutputBytes: 500,
      });

      const result = await execute(context, 'execute');

      // The preview should contain the beginning of the output
      expect(result['stdout']).toContain('PREVIEW_START_');
    }, 15_000);

    it('should pass full output to writeFile', async () => {
      const writeFileSpy = vi.fn(
        (_path: string, _content: Buffer): Promise<void> => Promise.resolve(),
      );
      const context = createTestContext(
        {
          command: `${process.execPath} -e "process.stdout.write('A'.repeat(2000))"`,
          maxOutputBytes: 500,
        },
        { writeFile: writeFileSpy },
      );

      await execute(context, 'execute');

      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const call = writeFileSpy.mock.calls[0];
      expect(call).toBeDefined();
      const [filePath, content] = call as [string, Buffer];
      expect(filePath).toContain('shell-output/stdout-');
      expect(Buffer.isBuffer(content)).toBe(true);
      expect(content.length).toBe(2000);
    }, 15_000);
  });

  // -------------------------------------------------------------------------
  // Parameter validation
  // -------------------------------------------------------------------------

  describe('parameter validation', () => {
    it('should require command parameter', async () => {
      const context = createTestContext({});

      await expect(execute(context, 'execute')).rejects.toThrow(
        'Parameter "command" is required',
      );
    });

    it('should reject empty command string', async () => {
      const context = createTestContext({ command: '' });

      await expect(execute(context, 'execute')).rejects.toThrow(
        'Parameter "command" is required',
      );
    });

    it('should reject non-string command', async () => {
      const context = createTestContext({ command: 123 });

      await expect(execute(context, 'execute')).rejects.toThrow(
        'Parameter "command" is required and must be a non-empty string',
      );
    });

    it('should accept optional timeoutMs', async () => {
      const context = createTestContext({
        command: 'echo ok',
        timeoutMs: 5000,
      });

      const result = await execute(context, 'execute');

      expect(result['exitCode']).toBe(0);
    });

    it('should reject non-number timeoutMs', async () => {
      const context = createTestContext({
        command: 'echo ok',
        timeoutMs: 'fast',
      });

      await expect(execute(context, 'execute')).rejects.toThrow(
        'Parameter "timeoutMs" must be a number',
      );
    });

    it('should accept optional maxOutputBytes', async () => {
      const context = createTestContext({
        command: 'echo ok',
        maxOutputBytes: 2048,
      });

      const result = await execute(context, 'execute');

      expect(result['exitCode']).toBe(0);
    });

    it('should reject non-number maxOutputBytes', async () => {
      const context = createTestContext({
        command: 'echo ok',
        maxOutputBytes: 'big',
      });

      await expect(execute(context, 'execute')).rejects.toThrow(
        'Parameter "maxOutputBytes" must be a number',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Unknown action
  // -------------------------------------------------------------------------

  describe('unknown action', () => {
    it('should throw on unknown action', async () => {
      const context = createTestContext({ command: 'echo test' });

      await expect(execute(context, 'run_script')).rejects.toThrow(
        'Unknown action: run_script',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe('logging', () => {
    it('should log the command being executed', async () => {
      const logSpy = vi.fn();
      const context = createTestContext(
        { command: 'echo hello' },
        { log: logSpy },
      );

      await execute(context, 'execute');

      expect(logSpy).toHaveBeenCalledWith(
        'Executing shell command: echo hello',
      );
    });

    it('should log exit code on success', async () => {
      const logSpy = vi.fn();
      const context = createTestContext(
        { command: 'echo ok' },
        { log: logSpy },
      );

      await execute(context, 'execute');

      expect(logSpy).toHaveBeenCalledWith('Command exited with code 0');
    });

    it('should log exit code on failure', async () => {
      const logSpy = vi.fn();
      const context = createTestContext(
        { command: 'exit 1' },
        { log: logSpy },
      );

      await execute(context, 'execute');

      expect(logSpy).toHaveBeenCalledWith('Command exited with code 1');
    });
  });

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  describe('provenance', () => {
    it('should not include _provenance (handled by GearHost)', async () => {
      const context = createTestContext({ command: 'echo test' });

      const result = await execute(context, 'execute');

      expect(result['_provenance']).toBeUndefined();
    });
  });
});
