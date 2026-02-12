// Phase 5.6 Security Test — Shell Gear Hardening
//
// Verifies the shell Gear's security properties:
// 1. Critical risk level ensures every execution requires user approval
// 2. Shell permission is explicitly declared (transparent about capabilities)
// 3. No parameter interpolation — command is executed as a single string
// 4. Exempt from Sentinel Memory auto-approval (cannot bypass approval)
// 5. Disabled by default (must be explicitly enabled)
//
// Architecture references:
//   - Section 5.6.5 (Shell Gear hardening)
//   - Section 5.6.2 (Gear Manifest)
//   - Security Rules (non-negotiable)
//   - Implementation Plan Phase 5.6

import { describe, it, expect, vi } from 'vitest';

import type { GearContext, FetchResponse } from '@meridian/shared';

import { execute } from '../../src/gear/builtin/shell/index.js';
import manifest from '../../src/gear/builtin/shell/manifest.json';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
      return Promise.reject(new Error('readFile not available in shell security tests'));
    },

    writeFile: vi.fn((): Promise<void> => Promise.resolve()),

    deleteFile(): Promise<void> {
      return Promise.reject(new Error('deleteFile not available'));
    },

    listFiles(): Promise<string[]> {
      return Promise.reject(new Error('listFiles not available'));
    },

    fetch(): Promise<FetchResponse> {
      return Promise.reject(new Error('fetch not available'));
    },

    log: vi.fn(),

    progress: vi.fn(),

    createSubJob(): Promise<never> {
      return Promise.reject(new Error('createSubJob not available'));
    },

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Shell Gear Security', () => {
  // -------------------------------------------------------------------------
  // 1. Cannot bypass approval requirement
  // -------------------------------------------------------------------------

  describe('approval requirement', () => {
    it('should have critical risk level requiring user approval', () => {
      // The execute action must be 'critical' — this ensures the approval
      // pipeline never auto-approves shell commands. The Sentinel and
      // approval system check riskLevel to determine approval requirements.
      for (const action of manifest.actions) {
        expect(action.riskLevel).toBe('critical');
      }
    });

    it('should declare shell permission explicitly', () => {
      // The shell: true permission is what the approval system checks
      // to enforce the auto-approval exemption. Without this, the
      // Sentinel Memory might auto-approve based on prior decisions.
      expect(manifest.permissions.shell).toBe(true);
    });

    it('should be identifiable for Sentinel Memory auto-approval exemption', () => {
      // The combination of shell: true + critical risk level is what
      // makes this Gear exempt from Sentinel Memory auto-approval.
      // Every single execution must require fresh user approval.
      expect(manifest.permissions.shell).toBe(true);
      for (const action of manifest.actions) {
        expect(action.riskLevel).toBe('critical');
      }
      expect(manifest.description).toContain('exempt from Sentinel Memory auto-approval');
    });

    it('should be marked as disabled by default', () => {
      // The description documents that this Gear requires explicit user
      // enablement. The registry enforces this by registering shell Gear
      // in disabled state during auto-registration.
      expect(manifest.description).toContain('Disabled by default');
    });
  });

  // -------------------------------------------------------------------------
  // 2. No command injection via parameters
  // -------------------------------------------------------------------------

  describe('command injection prevention', () => {
    it('should execute the command parameter as-is without interpolation', async () => {
      // The command should be taken as a literal string and passed to
      // the shell. There is no templating, interpolation, or construction
      // from multiple parameters.
      const context = createTestContext({
        command: 'echo "hello world"',
      });

      const result = await execute(context, 'execute');

      // The output should match what the literal command produces
      expect(result['stdout']).toBe('hello world\n');
      expect(result['command']).toBe('echo "hello world"');
    });

    it('should not use any parameter other than command for execution', async () => {
      // Extra parameters should NOT be interpolated into the command.
      // Even if an attacker adds unexpected parameters, they should be
      // ignored by the execution logic.
      const context = createTestContext({
        command: 'echo safe',
        malicious: '; rm -rf /',
        args: ['--dangerous'],
        inject: '$(evil)',
      });

      const result = await execute(context, 'execute');

      // Only the command was executed, extra params were ignored
      expect(result['stdout']).toBe('safe\n');
      expect(result['command']).toBe('echo safe');
    });

    it('should not escape or sanitize the command', async () => {
      // The command is a complete shell expression. The Gear does NOT
      // try to sanitize it — security comes from the approval pipeline.
      // Sanitizing could break legitimate commands.
      const context = createTestContext({
        command: 'echo "a && b" | cat',
      });

      const result = await execute(context, 'execute');

      // Shell operators in the command work as expected
      expect(result['stdout']).toContain('a && b');
    });

    it('should accept single command parameter only', () => {
      // Verify the manifest only requires 'command' — there are no
      // separate 'args', 'program', or 'flags' parameters that could
      // be used for injection.
      const action = manifest.actions.find((a) => a.name === 'execute');
      expect(action).toBeDefined();
      const params = action?.parameters as Record<string, unknown>;
      const properties = params['properties'] as Record<string, unknown>;

      // Only command, timeoutMs, and maxOutputBytes — no args/program/flags
      const paramNames = Object.keys(properties);
      expect(paramNames).toEqual(['command', 'timeoutMs', 'maxOutputBytes']);

      // Only command is required
      expect(params['required']).toEqual(['command']);

      // No additional properties allowed
      expect(params['additionalProperties']).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Vulnerability scanner compatibility
  // -------------------------------------------------------------------------

  describe('vulnerability scanner compatibility', () => {
    it('should not declare network permissions (prevents VULN_SHELL_WITH_NETWORK)', () => {
      // The VULN_SHELL_WITH_NETWORK pattern in manifest.ts flags Gear
      // that have both shell and network permissions as potential
      // exfiltration vectors. Shell Gear must not have network access.
      expect(
        (manifest.permissions as Record<string, unknown>)['network'],
      ).toBeUndefined();
    });

    it('should be builtin origin (prevents VULN_SHELL_DEFAULT_ENABLED)', () => {
      // The VULN_SHELL_DEFAULT_ENABLED pattern flags non-builtin Gear
      // with shell permissions. Builtin origin is exempt from this check.
      expect(manifest.origin).toBe('builtin');
    });

    it('should have restricted filesystem write scope', () => {
      // The shell Gear only needs workspace write access for output files.
      // The write scope is limited to shell-output/**, not ** (wildcard).
      const fs = manifest.permissions.filesystem;
      expect(fs).toBeDefined();
      expect(fs.write).toEqual(['shell-output/**']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Output does not leak internal state
  // -------------------------------------------------------------------------

  describe('output safety', () => {
    it('should not include _provenance in output', async () => {
      // _provenance is set by GearHost, not by the Gear itself.
      // If the Gear set it, an attacker could forge provenance.
      const context = createTestContext({ command: 'echo test' });

      const result = await execute(context, 'execute');

      expect(result['_provenance']).toBeUndefined();
    });

    it('should include only documented fields in output', async () => {
      const context = createTestContext({ command: 'echo check' });

      const result = await execute(context, 'execute');

      // Required fields
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('timedOut');
      expect(result).toHaveProperty('command');
      expect(result).toHaveProperty('executedAt');

      // No unexpected fields (signal, stdoutFile, stderrFile only when applicable)
      const keys = Object.keys(result);
      const allowedKeys = [
        'stdout', 'stderr', 'exitCode', 'timedOut', 'command',
        'executedAt', 'signal', 'stdoutFile', 'stderrFile',
      ];
      for (const key of keys) {
        expect(allowedKeys).toContain(key);
      }
    });
  });
});
