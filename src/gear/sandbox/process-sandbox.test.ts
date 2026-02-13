// @meridian/gear — Process sandbox unit tests (Phase 5.2)

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { GearManifest } from '@meridian/shared';
import { generateEphemeralKeypair, zeroPrivateKey, signPayload as ed25519SignPayload } from '@meridian/shared';

import {
  signMessage,
  verifySignature,
  generateSigningKey,
  generateSeatbeltProfile,
  generateSeccompProfile,
  buildSandboxEnv,
  injectSecrets,
  cleanupSecrets,
  createSandbox,
  destroySandbox,
  isPathAllowed,
  isDomainAllowed,
  signSandboxRequest,
  verifySandboxResponseSignature,
} from './process-sandbox.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTestManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'test-gear',
    name: 'Test Gear',
    version: '1.0.0',
    description: 'A test Gear for sandbox tests',
    author: 'Meridian',
    license: 'Apache-2.0',
    origin: 'user',
    checksum: 'abc123',
    actions: [
      {
        name: 'test_action',
        description: 'A test action',
        parameters: { type: 'object', properties: {} },
        returns: { type: 'object', properties: {} },
        riskLevel: 'low',
      },
    ],
    permissions: {
      filesystem: {
        read: ['workspace/**'],
        write: ['workspace/output/**'],
      },
    },
    resources: {
      maxMemoryMb: 128,
      timeoutMs: 5000,
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
  tempDir = mkdtempSync(join(tmpdir(), 'meridian-sandbox-test-'));
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HMAC signing and verification
// ---------------------------------------------------------------------------

describe('HMAC signing', () => {
  it('should sign a message and produce a base64 string', () => {
    const key = generateSigningKey();
    const payload = { action: 'test', parameters: { foo: 'bar' } };
    const signature = signMessage(payload, key);

    expect(signature).toBeTruthy();
    expect(typeof signature).toBe('string');
    // Valid base64
    expect(() => Buffer.from(signature, 'base64')).not.toThrow();
  });

  it('should verify a valid signature', () => {
    const key = generateSigningKey();
    const payload = { action: 'test', parameters: { value: 42 } };
    const signature = signMessage(payload, key);

    expect(verifySignature(payload, signature, key)).toBe(true);
  });

  it('should reject a tampered payload', () => {
    const key = generateSigningKey();
    const payload = { action: 'test', parameters: { value: 42 } };
    const signature = signMessage(payload, key);

    const tampered = { action: 'test', parameters: { value: 99 } };
    expect(verifySignature(tampered, signature, key)).toBe(false);
  });

  it('should reject a wrong key', () => {
    const key1 = generateSigningKey();
    const key2 = generateSigningKey();
    const payload = { action: 'test', parameters: {} };
    const signature = signMessage(payload, key1);

    expect(verifySignature(payload, signature, key2)).toBe(false);
  });

  it('should reject an empty signature', () => {
    const key = generateSigningKey();
    const payload = { action: 'test' };

    expect(verifySignature(payload, '', key)).toBe(false);
  });

  it('should produce different signatures for different payloads', () => {
    const key = generateSigningKey();
    const sig1 = signMessage({ a: 1 }, key);
    const sig2 = signMessage({ a: 2 }, key);

    expect(sig1).not.toBe(sig2);
  });

  it('should produce the same signature for the same payload and key', () => {
    const key = generateSigningKey();
    const payload = { action: 'test', value: 'stable' };
    const sig1 = signMessage(payload, key);
    const sig2 = signMessage(payload, key);

    expect(sig1).toBe(sig2);
  });

  it('should generate a 32-byte signing key', () => {
    const key = generateSigningKey();
    expect(key.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// macOS Seatbelt profile generation
// ---------------------------------------------------------------------------

describe('generateSeatbeltProfile', () => {
  it('should generate a valid Seatbelt profile', () => {
    const permissions = {
      filesystem: {
        read: ['workspace/**'],
        write: ['workspace/output/**'],
      },
    };
    const profile = generateSeatbeltProfile(
      permissions,
      '/workspace',
      null,
      '/tmp/sandbox',
    );

    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('/tmp/sandbox');
  });

  it('should include secrets directory access when provided', () => {
    const profile = generateSeatbeltProfile(
      {},
      '/workspace',
      '/tmp/secrets',
      '/tmp/sandbox',
    );

    expect(profile).toContain('/tmp/secrets');
  });

  it('should include network access when domains are declared', () => {
    const permissions = {
      network: { domains: ['api.example.com'] },
    };
    const profile = generateSeatbeltProfile(
      permissions,
      '/workspace',
      null,
      '/tmp/sandbox',
    );

    expect(profile).toContain('network-outbound');
  });

  it('should not include network access when no domains declared', () => {
    const profile = generateSeatbeltProfile(
      {},
      '/workspace',
      null,
      '/tmp/sandbox',
    );

    expect(profile).not.toContain('network-outbound');
  });

  it('should escape special characters in paths', () => {
    const profile = generateSeatbeltProfile(
      {},
      '/work space/dir',
      null,
      '/tmp/sand"box',
    );

    expect(profile).toContain('/tmp/sand\\"box');
  });
});

// ---------------------------------------------------------------------------
// Linux seccomp profile generation
// ---------------------------------------------------------------------------

describe('generateSeccompProfile', () => {
  it('should generate a profile with base syscalls', () => {
    const profile = generateSeccompProfile({}, { maxMemoryMb: 256 });

    expect(profile.allowedSyscalls).toContain('read');
    expect(profile.allowedSyscalls).toContain('write');
    expect(profile.allowedSyscalls).toContain('open');
    expect(profile.allowedSyscalls).toContain('close');
  });

  it('should allow network syscalls when domains are declared', () => {
    const profile = generateSeccompProfile(
      { network: { domains: ['api.example.com'] } },
      { maxMemoryMb: 256 },
    );

    expect(profile.networkAllowed).toBe(true);
    expect(profile.allowedSyscalls).toContain('socket');
    expect(profile.allowedSyscalls).toContain('connect');
  });

  it('should block network syscalls when no domains declared', () => {
    const profile = generateSeccompProfile({}, { maxMemoryMb: 256 });

    expect(profile.networkAllowed).toBe(false);
    expect(profile.blockedSyscalls).toContain('socket');
    expect(profile.blockedSyscalls).toContain('connect');
  });

  it('should block exec syscalls when shell is not allowed', () => {
    const profile = generateSeccompProfile(
      { shell: false },
      { maxMemoryMb: 256 },
    );

    expect(profile.blockedSyscalls).toContain('execve');
  });

  it('should calculate max memory in bytes', () => {
    const profile = generateSeccompProfile({}, { maxMemoryMb: 128 });

    expect(profile.maxMemoryBytes).toBe(128 * 1024 * 1024);
  });

  it('should always block dangerous syscalls', () => {
    const profile = generateSeccompProfile({}, { maxMemoryMb: 256 });

    expect(profile.blockedSyscalls).toContain('ptrace');
    expect(profile.blockedSyscalls).toContain('mount');
    expect(profile.blockedSyscalls).toContain('reboot');
  });
});

// ---------------------------------------------------------------------------
// Sandbox environment construction
// ---------------------------------------------------------------------------

describe('buildSandboxEnv', () => {
  it('should include required environment variables', () => {
    const manifest = createTestManifest();
    const env = buildSandboxEnv(manifest, '/sandbox', null);

    expect(env['PATH']).toBeDefined();
    expect(env['MERIDIAN_WORKSPACE']).toBe('/sandbox');
    expect(env['MERIDIAN_GEAR_ID']).toBe('test-gear');
    expect(env['MERIDIAN_GEAR_VERSION']).toBe('1.0.0');
    expect(env['NODE_ENV']).toBe('production');
  });

  it('should include secrets directory when provided', () => {
    const manifest = createTestManifest();
    const env = buildSandboxEnv(manifest, '/sandbox', '/secrets');

    expect(env['MERIDIAN_SECRETS_DIR']).toBe('/secrets');
  });

  it('should not include secrets directory when null', () => {
    const manifest = createTestManifest();
    const env = buildSandboxEnv(manifest, '/sandbox', null);

    expect(env['MERIDIAN_SECRETS_DIR']).toBeUndefined();
  });

  it('should pass declared environment variables from process.env', () => {
    process.env['TEST_VAR_SANDBOX'] = 'hello';
    try {
      const manifest = createTestManifest({
        permissions: { environment: ['TEST_VAR_SANDBOX'] },
      });
      const env = buildSandboxEnv(manifest, '/sandbox', null);

      expect(env['TEST_VAR_SANDBOX']).toBe('hello');
    } finally {
      delete process.env['TEST_VAR_SANDBOX'];
    }
  });

  it('should not pass undeclared environment variables', () => {
    process.env['SECRET_KEY_SANDBOX'] = 'top-secret';
    try {
      const manifest = createTestManifest({ permissions: {} });
      const env = buildSandboxEnv(manifest, '/sandbox', null);

      expect(env['SECRET_KEY_SANDBOX']).toBeUndefined();
    } finally {
      delete process.env['SECRET_KEY_SANDBOX'];
    }
  });

  it('should not include HOME or USER', () => {
    const manifest = createTestManifest();
    const env = buildSandboxEnv(manifest, '/sandbox', null);

    expect(env['HOME']).toBeUndefined();
    expect(env['USER']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Secrets injection
// ---------------------------------------------------------------------------

describe('injectSecrets', () => {
  it('should create secret files in a temp directory', () => {
    const secrets = new Map<string, Buffer>([
      ['api_key', Buffer.from('my-secret-key')],
      ['db_pass', Buffer.from('my-db-password')],
    ]);

    const secretsDir = injectSecrets(secrets, ['api_key', 'db_pass']);

    try {
      expect(secretsDir).not.toBeNull();
      if (!secretsDir) return;
      expect(existsSync(join(secretsDir, 'api_key'))).toBe(true);
      expect(existsSync(join(secretsDir, 'db_pass'))).toBe(true);

      // Verify content was written correctly
      const content = readFileSync(join(secretsDir, 'api_key'), 'utf-8');
      // Note: the buffer was zeroed, but the file has the original content
      expect(content).toBe('my-secret-key');
    } finally {
      if (secretsDir) {
        rmSync(secretsDir, { recursive: true, force: true });
      }
    }
  });

  it('should zero the secret Buffers after injection', () => {
    const secretValue = Buffer.from('sensitive-data');
    const secrets = new Map<string, Buffer>([['key', secretValue]]);

    const secretsDir = injectSecrets(secrets, ['key']);

    try {
      // Buffer should be zeroed
      expect(secretValue.every((b) => b === 0)).toBe(true);
    } finally {
      if (secretsDir) {
        rmSync(secretsDir, { recursive: true, force: true });
      }
    }
  });

  it('should skip undeclared secrets', () => {
    const secrets = new Map<string, Buffer>([
      ['declared', Buffer.from('ok')],
      ['undeclared', Buffer.from('no')],
    ]);

    const secretsDir = injectSecrets(secrets, ['declared'], noopLogger);

    try {
      expect(secretsDir).not.toBeNull();
      if (!secretsDir) return;
      expect(existsSync(join(secretsDir, 'declared'))).toBe(true);
      expect(existsSync(join(secretsDir, 'undeclared'))).toBe(false);
    } finally {
      if (secretsDir) {
        rmSync(secretsDir, { recursive: true, force: true });
      }
    }
  });

  it('should return null for empty secrets map', () => {
    const secrets = new Map<string, Buffer>();
    const result = injectSecrets(secrets, []);

    expect(result).toBeNull();
  });
});

describe('cleanupSecrets', () => {
  it('should remove the secrets directory', () => {
    const secretsDir = mkdtempSync(join(tmpdir(), 'meridian-cleanup-test-'));
    writeFileSync(join(secretsDir, 'secret'), 'value');

    cleanupSecrets(secretsDir);

    expect(existsSync(secretsDir)).toBe(false);
  });

  it('should handle null gracefully', () => {
    expect(() => { cleanupSecrets(null); }).not.toThrow();
  });

  it('should handle non-existent directory gracefully', () => {
    expect(() => { cleanupSecrets('/nonexistent/path'); }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sandbox creation and destruction
// ---------------------------------------------------------------------------

describe('createSandbox', () => {
  it('should create a sandbox with a valid entry point', () => {
    // Create a minimal Gear entry point
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
      expect(result.value.process.pid).toBeDefined();
      expect(result.value.destroyed).toBe(false);
      expect(result.value.sandboxDir).toBeTruthy();

      // Clean up
      result.value.process.kill('SIGKILL');
    }
  });

  it('should fail for non-existent entry point', () => {
    const result = createSandbox({
      entryPoint: '/nonexistent/gear/index.js',
      manifest: createTestManifest(),
      signingKey: generateSigningKey(),
      workspacePath: tempDir,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not found');
    }
  });

  it('should inject secrets when provided', () => {
    const gearDir = join(tempDir, 'gear');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    writeFileSync(entryPoint, 'process.stdin.resume();');

    const workspaceDir = join(tempDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    const secrets = new Map<string, Buffer>([
      ['api_key', Buffer.from('secret-value')],
    ]);

    const manifest = createTestManifest({
      permissions: {
        secrets: ['api_key'],
      },
    });

    const result = createSandbox({
      entryPoint,
      manifest,
      signingKey: generateSigningKey(),
      workspacePath: workspaceDir,
      secrets,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.secretsDir).not.toBeNull();

      // Clean up
      result.value.process.kill('SIGKILL');
    }
  });

  it('should apply memory limit via --max-old-space-size', () => {
    const gearDir = join(tempDir, 'gear');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    writeFileSync(entryPoint, 'process.stdin.resume();');

    const workspaceDir = join(tempDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    const manifest = createTestManifest({
      resources: { maxMemoryMb: 64 },
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
      expect(result.value.process.spawnargs).toBeDefined();
      // The --max-old-space-size flag should be in the spawn args
      const args = result.value.process.spawnargs;
      expect(args.some((a: string) => a.includes('max-old-space-size=64'))).toBe(true);

      // Clean up
      result.value.process.kill('SIGKILL');
    }
  });
});

describe('destroySandbox', () => {
  it('should kill the process and clean up', async () => {
    const gearDir = join(tempDir, 'gear');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    // Process that stays alive
    writeFileSync(entryPoint, 'process.stdin.resume(); setInterval(() => {}, 1000);');

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
    const sandboxDir = handle.sandboxDir;

    await destroySandbox(handle, noopLogger);

    expect(handle.destroyed).toBe(true);
    expect(existsSync(sandboxDir)).toBe(false);
  });

  it('should be idempotent', async () => {
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
    if (!result.ok) return;

    const handle = result.value;

    // Destroy twice
    await destroySandbox(handle, noopLogger);
    await destroySandbox(handle, noopLogger);

    expect(handle.destroyed).toBe(true);
  });

  it('should clean up secrets directory', async () => {
    const gearDir = join(tempDir, 'gear');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    writeFileSync(entryPoint, 'process.stdin.resume();');

    const workspaceDir = join(tempDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    const secrets = new Map<string, Buffer>([
      ['key', Buffer.from('value')],
    ]);

    const manifest = createTestManifest({
      permissions: { secrets: ['key'] },
    });

    const result = createSandbox({
      entryPoint,
      manifest,
      signingKey: generateSigningKey(),
      workspacePath: workspaceDir,
      secrets,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const handle = result.value;
    const secretsDir = handle.secretsDir;
    expect(secretsDir).not.toBeNull();

    await destroySandbox(handle, noopLogger);

    if (secretsDir) {
      expect(existsSync(secretsDir)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

describe('isPathAllowed', () => {
  it('should allow paths within declared directories', () => {
    expect(isPathAllowed('workspace/file.txt', ['workspace/**'], '/base')).toBe(true);
  });

  it('should reject path traversal attempts', () => {
    expect(isPathAllowed('../etc/passwd', ['workspace/**'], '/base')).toBe(false);
  });

  it('should reject absolute paths outside base', () => {
    expect(isPathAllowed('/etc/passwd', ['workspace/**'], '/base')).toBe(false);
  });

  it('should reject paths not matching any allowed pattern', () => {
    expect(isPathAllowed('workspace/file.txt', ['other/**'], '/base')).toBe(false);
  });

  it('should handle nested path traversal', () => {
    expect(isPathAllowed('workspace/../../etc/passwd', ['workspace/**'], '/base')).toBe(false);
  });

  it('should handle empty allowed paths', () => {
    expect(isPathAllowed('workspace/file.txt', [], '/base')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

describe('isDomainAllowed', () => {
  it('should allow exact domain matches', () => {
    expect(isDomainAllowed('api.example.com', ['api.example.com'])).toBe(true);
  });

  it('should allow wildcard subdomain matches', () => {
    expect(isDomainAllowed('api.example.com', ['*.example.com'])).toBe(true);
  });

  it('should reject non-matching domains', () => {
    expect(isDomainAllowed('evil.com', ['api.example.com'])).toBe(false);
  });

  it('should reject when no domains are declared', () => {
    expect(isDomainAllowed('api.example.com', undefined)).toBe(false);
    expect(isDomainAllowed('api.example.com', [])).toBe(false);
  });

  it('should block private IP addresses', () => {
    expect(isDomainAllowed('10.0.0.1', ['*'])).toBe(false);
    expect(isDomainAllowed('172.16.0.1', ['*'])).toBe(false);
    expect(isDomainAllowed('192.168.1.1', ['*'])).toBe(false);
    expect(isDomainAllowed('127.0.0.1', ['*'])).toBe(false);
    expect(isDomainAllowed('localhost', ['*'])).toBe(false);
  });

  it('should block IPv6 loopback', () => {
    expect(isDomainAllowed('::1', ['*'])).toBe(false);
  });

  it('should block IPv6 link-local', () => {
    expect(isDomainAllowed('fe80::1', ['*'])).toBe(false);
  });

  it('should allow wildcard for non-private domains', () => {
    expect(isDomainAllowed('api.github.com', ['*'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ed25519 sandbox signing (v0.2)
// ---------------------------------------------------------------------------

describe('Ed25519 sandbox signing', () => {
  it('should sign a sandbox request with Ed25519', () => {
    const keypair = generateEphemeralKeypair();
    const request = signSandboxRequest(
      { correlationId: 'corr-1', action: 'test', parameters: { foo: 'bar' } },
      keypair.privateKey,
      'test-gear',
    );

    expect(request.hmac).toBe('ed25519');
    expect(request.envelope).toBeDefined();
    expect(request.envelope?.signer).toBe('gear:test-gear');
    expect(request.envelope?.signature).toBeTruthy();
    expect(request.correlationId).toBe('corr-1');
    expect(request.action).toBe('test');

    zeroPrivateKey(keypair);
  });

  it('should verify a valid Ed25519 sandbox response', () => {
    const keypair = generateEphemeralKeypair();

    // Simulate a signed response from the sandbox
    const payload = {
      correlationId: 'corr-1',
      result: { data: 'test' },
    };
    const envelope = ed25519SignPayload(payload, keypair.privateKey, 'gear:test-gear');

    const response = {
      ...payload,
      hmac: 'ed25519' as const,
      envelope: {
        messageId: envelope.messageId,
        timestamp: envelope.timestamp,
        signer: envelope.signer,
        payload: envelope.payload,
        signature: envelope.signature,
      },
    };

    expect(verifySandboxResponseSignature(response, keypair.publicKey)).toBe(true);

    zeroPrivateKey(keypair);
  });

  it('should reject a response with no envelope', () => {
    const keypair = generateEphemeralKeypair();
    const response = {
      correlationId: 'corr-1',
      result: { data: 'test' },
      hmac: 'ed25519' as const,
    };

    expect(verifySandboxResponseSignature(response, keypair.publicKey)).toBe(false);

    zeroPrivateKey(keypair);
  });

  it('should reject a response with wrong public key', () => {
    const keypair1 = generateEphemeralKeypair();
    const keypair2 = generateEphemeralKeypair();

    const payload = { correlationId: 'corr-1', result: {} };
    const envelope = ed25519SignPayload(payload, keypair1.privateKey, 'gear:test-gear');

    const response = {
      ...payload,
      hmac: 'ed25519' as const,
      envelope: {
        messageId: envelope.messageId,
        timestamp: envelope.timestamp,
        signer: envelope.signer,
        payload: envelope.payload,
        signature: envelope.signature,
      },
    };

    // Verify with wrong public key
    expect(verifySandboxResponseSignature(response, keypair2.publicKey)).toBe(false);

    zeroPrivateKey(keypair1);
    zeroPrivateKey(keypair2);
  });

  it('should include ephemeral keypair in sandbox handle', () => {
    const gearDir = join(tempDir, 'gear-ed25519');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    writeFileSync(entryPoint, 'process.stdin.resume();');

    const workspaceDir = join(tempDir, 'workspace-ed25519');
    mkdirSync(workspaceDir, { recursive: true });

    const ephemeralKeypair = generateEphemeralKeypair();

    const result = createSandbox({
      entryPoint,
      manifest: createTestManifest(),
      signingKey: generateSigningKey(),
      workspacePath: workspaceDir,
      logger: noopLogger,
      ephemeralKeypair,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ephemeralKeypair).toBeDefined();
      expect(result.value.ephemeralKeypair?.publicKey).toBeDefined();

      // Clean up
      result.value.process.kill('SIGKILL');
    }
  });

  it('should zero ephemeral keypair on sandbox destruction', async () => {
    const gearDir = join(tempDir, 'gear-ed25519-destroy');
    mkdirSync(gearDir, { recursive: true });
    const entryPoint = join(gearDir, 'index.js');
    writeFileSync(entryPoint, 'process.stdin.resume(); setInterval(() => {}, 1000);');

    const workspaceDir = join(tempDir, 'workspace-ed25519-destroy');
    mkdirSync(workspaceDir, { recursive: true });

    const ephemeralKeypair = generateEphemeralKeypair();
    const privateKeyRef = ephemeralKeypair.privateKey;

    const result = createSandbox({
      entryPoint,
      manifest: createTestManifest(),
      signingKey: generateSigningKey(),
      workspacePath: workspaceDir,
      logger: noopLogger,
      ephemeralKeypair,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await destroySandbox(result.value, noopLogger);

    // Private key should be zeroed
    expect(privateKeyRef.every((b) => b === 0)).toBe(true);
    // Ephemeral keypair should be cleared
    expect(result.value.ephemeralKeypair).toBeUndefined();
  });
});
