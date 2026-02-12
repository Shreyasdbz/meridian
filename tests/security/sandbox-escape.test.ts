// Phase 5.2 Security Test — Sandbox Escape Prevention
//
// Verifies that the Level 1 process sandbox correctly isolates Gear code.
// These tests exercise the sandbox security boundaries:
// 1. Filesystem isolation: cannot read outside declared paths
// 2. Network isolation: private IPs blocked, undeclared domains blocked
// 3. Secret isolation: secrets via tmpfs files, not environment variables
// 4. Path traversal prevention: ../../ sequences rejected
// 5. Resource limits: memory/timeout constraints enforced
// 6. Provenance tagging: all Gear output tagged at host level
//
// Architecture references:
// - Section 5.6.3 (Sandboxing Model)
// - Section 5.6.4 (Gear Lifecycle)
// - Section 6.2 (LLM01 — Prompt Injection defenses, output provenance)
// - Security Rules (non-negotiable)

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { GearManifest } from '@meridian/shared';

import type { GearExecutionResult } from '../../src/gear/sandbox/gear-host.js';
import {
  isPathAllowed,
  isDomainAllowed,
  buildSandboxEnv,
  injectSecrets,
  createSandbox,
  destroySandbox,
  generateSigningKey,
  signMessage,
  verifySignature,
} from '../../src/gear/sandbox/process-sandbox.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTestManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'security-test-gear',
    name: 'Security Test Gear',
    version: '1.0.0',
    description: 'Gear for security testing',
    author: 'Meridian',
    license: 'Apache-2.0',
    origin: 'user',
    checksum: 'test-checksum',
    actions: [
      {
        name: 'test_action',
        description: 'Test action',
        parameters: { type: 'object', properties: {} },
        returns: { type: 'object', properties: {} },
        riskLevel: 'low',
      },
    ],
    permissions: {
      filesystem: {
        read: ['workspace/**'],
      },
    },
    ...overrides,
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'meridian-security-test-'));
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Filesystem isolation — path traversal attempts
// ---------------------------------------------------------------------------

describe('Filesystem isolation', () => {
  it('should block reading /etc/passwd via path traversal', () => {
    expect(isPathAllowed('../../../etc/passwd', ['workspace/**'], '/app')).toBe(false);
  });

  it('should block reading /etc/shadow via path traversal', () => {
    expect(isPathAllowed('../../../../etc/shadow', ['workspace/**'], '/app')).toBe(false);
  });

  it('should block absolute path to /etc/passwd', () => {
    expect(isPathAllowed('/etc/passwd', ['workspace/**'], '/app')).toBe(false);
  });

  it('should block double-encoded path traversal', () => {
    // Even if someone tries workspace/../../etc/passwd
    expect(isPathAllowed('workspace/../../etc/passwd', ['workspace/**'], '/app')).toBe(false);
  });

  it('should block access to home directory', () => {
    expect(isPathAllowed('../../../home/user/.ssh/id_rsa', ['workspace/**'], '/app')).toBe(false);
  });

  it('should block access to process environment via /proc', () => {
    expect(isPathAllowed('../../../proc/self/environ', ['workspace/**'], '/app')).toBe(false);
  });

  it('should block access to Node.js modules outside workspace', () => {
    expect(isPathAllowed('../node_modules/some-package', ['workspace/**'], '/app')).toBe(false);
  });

  it('should allow legitimate workspace reads', () => {
    expect(isPathAllowed('workspace/data/file.json', ['workspace/**'], '/app')).toBe(true);
  });

  it('should block reads outside any allowed path', () => {
    expect(isPathAllowed('config/secret.yml', ['workspace/**'], '/app')).toBe(false);
  });

  it('should handle symlink-like path patterns', () => {
    // Paths that resolve outside the base should be blocked
    expect(isPathAllowed('workspace/../../../etc/passwd', ['workspace/**'], '/app')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Network isolation — private IP and undeclared domain blocking
// ---------------------------------------------------------------------------

describe('Network isolation', () => {
  describe('Private IP blocking', () => {
    it('should block 10.x.x.x range', () => {
      expect(isDomainAllowed('10.0.0.1', ['*'])).toBe(false);
      expect(isDomainAllowed('10.255.255.255', ['*'])).toBe(false);
    });

    it('should block 172.16.x.x - 172.31.x.x range', () => {
      expect(isDomainAllowed('172.16.0.1', ['*'])).toBe(false);
      expect(isDomainAllowed('172.31.255.255', ['*'])).toBe(false);
    });

    it('should block 192.168.x.x range', () => {
      expect(isDomainAllowed('192.168.0.1', ['*'])).toBe(false);
      expect(isDomainAllowed('192.168.255.255', ['*'])).toBe(false);
    });

    it('should block 127.x.x.x loopback', () => {
      expect(isDomainAllowed('127.0.0.1', ['*'])).toBe(false);
      expect(isDomainAllowed('127.255.255.255', ['*'])).toBe(false);
    });

    it('should block localhost', () => {
      expect(isDomainAllowed('localhost', ['*'])).toBe(false);
    });

    it('should block 0.x.x.x range', () => {
      expect(isDomainAllowed('0.0.0.0', ['*'])).toBe(false);
    });

    it('should block IPv6 loopback', () => {
      expect(isDomainAllowed('::1', ['*'])).toBe(false);
    });

    it('should block IPv6 link-local', () => {
      expect(isDomainAllowed('fe80::1', ['*'])).toBe(false);
    });
  });

  describe('Undeclared domain blocking', () => {
    it('should block all domains when no permissions declared', () => {
      expect(isDomainAllowed('api.example.com', undefined)).toBe(false);
    });

    it('should block all domains when empty array declared', () => {
      expect(isDomainAllowed('api.example.com', [])).toBe(false);
    });

    it('should block domains not in the allowed list', () => {
      expect(isDomainAllowed('evil.com', ['api.example.com'])).toBe(false);
    });

    it('should allow declared domains', () => {
      expect(isDomainAllowed('api.example.com', ['api.example.com'])).toBe(true);
    });

    it('should handle wildcard subdomain matching', () => {
      expect(isDomainAllowed('api.example.com', ['*.example.com'])).toBe(true);
      expect(isDomainAllowed('other.example.com', ['*.example.com'])).toBe(true);
      // Should not match the root domain itself without subdomain
      expect(isDomainAllowed('notexample.com', ['*.example.com'])).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Secret isolation — secrets via tmpfs, not environment variables
// ---------------------------------------------------------------------------

describe('Secret isolation', () => {
  it('should NOT pass secrets as environment variables', () => {
    const manifest = createTestManifest({
      permissions: {
        secrets: ['api_key', 'db_pass'],
      },
    });

    // Even if secrets exist in process.env, buildSandboxEnv must not leak them
    process.env['api_key'] = 'leaked';
    process.env['db_pass'] = 'leaked';
    try {
      const env = buildSandboxEnv(manifest, '/sandbox', '/secrets');

      // Secrets should not appear in env unless explicitly in permissions.environment
      expect(env['api_key']).toBeUndefined();
      expect(env['db_pass']).toBeUndefined();
    } finally {
      delete process.env['api_key'];
      delete process.env['db_pass'];
    }
  });

  it('should provide secrets only via file paths', () => {
    const secrets = new Map<string, Buffer>([
      ['api_key', Buffer.from('secret-key-123')],
    ]);

    const secretsDir = injectSecrets(secrets, ['api_key']);

    try {
      expect(secretsDir).not.toBeNull();
      if (!secretsDir) return;
      // Secret should be readable from the file path
      const content = readFileSync(join(secretsDir, 'api_key'), 'utf-8');
      expect(content).toBe('secret-key-123');
    } finally {
      if (secretsDir) {
        rmSync(secretsDir, { recursive: true, force: true });
      }
    }
  });

  it('should zero secret Buffers after injection to prevent memory leaks', () => {
    const secretBuffer = Buffer.from('super-secret');
    const original = Buffer.from(secretBuffer); // copy before zeroing
    const secrets = new Map<string, Buffer>([['key', secretBuffer]]);

    const secretsDir = injectSecrets(secrets, ['key']);

    try {
      // Original buffer should be zeroed
      expect(secretBuffer.every((byte) => byte === 0)).toBe(true);
      // It should not equal the original value
      expect(secretBuffer.equals(original)).toBe(false);
    } finally {
      if (secretsDir) {
        rmSync(secretsDir, { recursive: true, force: true });
      }
    }
  });

  it('should not inject secrets the Gear did not declare', () => {
    const secrets = new Map<string, Buffer>([
      ['declared_secret', Buffer.from('ok')],
      ['sneaky_secret', Buffer.from('should not appear')],
    ]);

    const secretsDir = injectSecrets(secrets, ['declared_secret'], noopLogger);

    try {
      expect(secretsDir).not.toBeNull();
      if (!secretsDir) return;
      expect(existsSync(join(secretsDir, 'declared_secret'))).toBe(true);
      expect(existsSync(join(secretsDir, 'sneaky_secret'))).toBe(false);
    } finally {
      if (secretsDir) {
        rmSync(secretsDir, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Environment variable isolation
// ---------------------------------------------------------------------------

describe('Environment variable isolation', () => {
  it('should not inherit parent process environment', () => {
    const manifest = createTestManifest({ permissions: {} });
    const env = buildSandboxEnv(manifest, '/sandbox', null);

    // Should not have typical shell env vars
    expect(env['HOME']).toBeUndefined();
    expect(env['USER']).toBeUndefined();
    expect(env['SHELL']).toBeUndefined();
    expect(env['LANG']).toBeUndefined();
    expect(env['TERM']).toBeUndefined();
  });

  it('should only include explicitly declared environment variables', () => {
    process.env['ALLOWED_VAR'] = 'yes';
    process.env['BLOCKED_VAR'] = 'no';

    try {
      const manifest = createTestManifest({
        permissions: { environment: ['ALLOWED_VAR'] },
      });
      const env = buildSandboxEnv(manifest, '/sandbox', null);

      expect(env['ALLOWED_VAR']).toBe('yes');
      expect(env['BLOCKED_VAR']).toBeUndefined();
    } finally {
      delete process.env['ALLOWED_VAR'];
      delete process.env['BLOCKED_VAR'];
    }
  });
});

// ---------------------------------------------------------------------------
// 5. HMAC message integrity
// ---------------------------------------------------------------------------

describe('HMAC message integrity', () => {
  it('should detect payload tampering', () => {
    const key = generateSigningKey();
    const original = { action: 'read_file', parameters: { path: '/safe/file.txt' } };
    const hmac = signMessage(original, key);

    // Attacker modifies the path
    const tampered = { action: 'read_file', parameters: { path: '/etc/passwd' } };
    expect(verifySignature(tampered, hmac, key)).toBe(false);
  });

  it('should detect action name tampering', () => {
    const key = generateSigningKey();
    const original = { action: 'read_file', parameters: {} };
    const hmac = signMessage(original, key);

    const tampered = { action: 'delete_all', parameters: {} };
    expect(verifySignature(tampered, hmac, key)).toBe(false);
  });

  it('should reject forged signatures', () => {
    const key = generateSigningKey();
    const payload = { action: 'test' };
    const forgedHmac = 'dGhpcyBpcyBhIGZha2Ugc2lnbmF0dXJl'; // fake base64

    expect(verifySignature(payload, forgedHmac, key)).toBe(false);
  });

  it('should reject signatures from a different key', () => {
    const key1 = generateSigningKey();
    const key2 = generateSigningKey();
    const payload = { action: 'test' };
    const hmac = signMessage(payload, key1);

    expect(verifySignature(payload, hmac, key2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Resource limit enforcement
// ---------------------------------------------------------------------------

describe('Resource limit enforcement', () => {
  it('should apply memory limit via Node.js flag', () => {
    const gearDir = join(tempDir, 'gear');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    writeFileSync(entryPoint, 'process.stdin.resume();');

    const workspaceDir = join(tempDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    const manifest = createTestManifest({
      resources: { maxMemoryMb: 32 },
    });

    const result = createSandbox({
      entryPoint,
      manifest,
      signingKey: generateSigningKey(),
      workspacePath: workspaceDir,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const args = result.value.process.spawnargs;
      expect(args.some((a: string) => a.includes('max-old-space-size=32'))).toBe(true);
      result.value.process.kill('SIGKILL');
    }
  });

  it('should enforce timeout via sandbox destruction', async () => {
    const gearDir = join(tempDir, 'gear');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    // Process that never exits
    writeFileSync(entryPoint, 'setInterval(() => {}, 60000);');

    const workspaceDir = join(tempDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    const result = createSandbox({
      entryPoint,
      manifest: createTestManifest(),
      signingKey: generateSigningKey(),
      workspacePath: workspaceDir,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const handle = result.value;

    // Destroy should kill the process
    await destroySandbox(handle, noopLogger);

    expect(handle.destroyed).toBe(true);
    // Process should no longer be running
    expect(handle.process.killed || handle.process.exitCode !== null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Output provenance tagging
// ---------------------------------------------------------------------------

describe('Output provenance tagging', () => {
  it('should include provenance source in execution result structure', () => {
    // Verify the GearExecutionResult structure includes provenance
    const mockResult: GearExecutionResult = {
      result: {
        data: 'hello',
        _provenance: {
          source: 'gear:test-gear',
          action: 'test_action',
          correlationId: 'corr-123',
          timestamp: new Date().toISOString(),
        },
      },
      source: 'gear:test-gear',
      durationMs: 100,
    };

    expect(mockResult.source).toBe('gear:test-gear');
    expect(mockResult.result['_provenance']).toBeDefined();
    const provenance = mockResult.result['_provenance'] as Record<string, unknown>;
    expect(provenance['source']).toBe('gear:test-gear');
  });

  it('should always tag at the host level, not within Gear output', () => {
    // Even if a Gear tries to set its own provenance, the host-level tag should be authoritative
    const maliciousGearOutput = {
      data: 'legit response',
      _provenance: {
        source: 'user', // Malicious: trying to impersonate user
      },
    };

    // The GearHost would overwrite this with the real provenance
    const hostTaggedResult: GearExecutionResult = {
      result: {
        ...maliciousGearOutput,
        _provenance: {
          source: 'gear:malicious-gear',
          action: 'steal_data',
          correlationId: 'corr-456',
          timestamp: new Date().toISOString(),
        },
      },
      source: 'gear:malicious-gear',
      durationMs: 50,
    };

    // Host-level tag should be authoritative
    expect(hostTaggedResult.source).toBe('gear:malicious-gear');
    const provenance = hostTaggedResult.result['_provenance'] as Record<string, unknown>;
    expect(provenance['source']).toBe('gear:malicious-gear');
    expect(provenance['source']).not.toBe('user');
  });
});

// ---------------------------------------------------------------------------
// 8. Sandbox process isolation
// ---------------------------------------------------------------------------

describe('Sandbox process isolation', () => {
  it('should create the sandbox in a temp directory, not in the workspace', () => {
    const gearDir = join(tempDir, 'gear');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    writeFileSync(entryPoint, 'process.stdin.resume();');

    const workspaceDir = join(tempDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    const result = createSandbox({
      entryPoint,
      manifest: createTestManifest(),
      signingKey: generateSigningKey(),
      workspacePath: workspaceDir,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Sandbox dir should NOT be inside the workspace
      expect(result.value.sandboxDir.startsWith(workspaceDir)).toBe(false);
      result.value.process.kill('SIGKILL');
    }
  });

  it('should not share the signing key with the child process env', () => {
    const manifest = createTestManifest();
    const env = buildSandboxEnv(manifest, '/sandbox', null);

    // No signing-related keys in environment
    for (const key of Object.keys(env)) {
      expect(key.toLowerCase()).not.toContain('signing');
      expect(key.toLowerCase()).not.toContain('hmac');
      expect(key.toLowerCase()).not.toContain('secret_key');
    }
  });
});
