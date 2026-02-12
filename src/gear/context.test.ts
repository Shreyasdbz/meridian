// @meridian/gear — GearContext unit tests (Phase 5.3)
//
// Tests for the constrained API available to Gear code inside the sandbox:
// - File operations respect declared paths
// - Undeclared file access rejected
// - Network requests respect declared domains
// - Undeclared network requests blocked
// - Private IP ranges blocked
// - DNS rebinding prevention
// - Secret ACL enforcement
// - Sub-job creation routes through Axis
// - Log and progress methods
//
// Architecture references:
// - Section 9.3 (GearContext API)
// - Section 6.5 (Network Security, DNS rebinding)
// - Section 5.6.2 (Gear Manifest, permissions)

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { GearManifest, JobResult } from '@meridian/shared';

import {
  GearContextImpl,
  createGearContext,
  validatePath,
  validateUrl,
  isPrivateIp,
  checkDnsRebinding,
} from './context.js';
import type { GearContextConfig, DnsResolver } from './context.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTestManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'test-gear',
    name: 'Test Gear',
    version: '1.0.0',
    description: 'A test Gear for context tests',
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
        read: ['data/**'],
        write: ['data/output/**'],
      },
      network: {
        domains: ['api.example.com', '*.github.com'],
        protocols: ['https'],
      },
      secrets: ['api_key', 'db_password'],
    },
    ...overrides,
  };
}

let tempDir: string;
let workspacePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'meridian-context-test-'));
  workspacePath = join(tempDir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });

  // Create test directory structure
  mkdirSync(join(workspacePath, 'data', 'output'), { recursive: true });
  mkdirSync(join(workspacePath, 'data', 'input'), { recursive: true });
  writeFileSync(join(workspacePath, 'data', 'input', 'test.txt'), 'hello world');
  writeFileSync(join(workspacePath, 'data', 'config.json'), '{"key":"value"}');
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTestConfig(
  overrides?: Partial<GearContextConfig>,
): GearContextConfig {
  return {
    manifest: createTestManifest(),
    params: { input: 'test-value' },
    workspacePath,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Path validation (validatePath)
// ---------------------------------------------------------------------------

describe('validatePath', () => {
  it('should allow paths within declared read patterns', () => {
    const result = validatePath('data/input/test.txt', ['data/**'], workspacePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(resolve(workspacePath, 'data/input/test.txt'));
    }
  });

  it('should reject paths outside declared patterns', () => {
    const result = validatePath('config/secret.yml', ['data/**'], workspacePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not covered by declared filesystem permissions');
    }
  });

  it('should reject directory traversal with ../', () => {
    const result = validatePath('../../../etc/passwd', ['data/**'], workspacePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('outside workspace boundary');
    }
  });

  it('should reject double-encoded traversal', () => {
    const result = validatePath('data/../../etc/passwd', ['data/**'], workspacePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('outside workspace boundary');
    }
  });

  it('should reject absolute paths outside workspace', () => {
    const result = validatePath('/etc/passwd', ['data/**'], workspacePath);
    expect(result.ok).toBe(false);
  });

  it('should reject when no filesystem permissions declared', () => {
    const result = validatePath('any/file.txt', undefined, workspacePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No filesystem permissions declared');
    }
  });

  it('should reject when empty permissions array', () => {
    const result = validatePath('any/file.txt', [], workspacePath);
    expect(result.ok).toBe(false);
  });

  it('should allow wildcard ** pattern for workspace root', () => {
    const result = validatePath('anything/file.txt', ['**'], workspacePath);
    expect(result.ok).toBe(true);
  });

  it('should handle deeply nested allowed paths', () => {
    const result = validatePath(
      'data/output/deep/nested/file.txt',
      ['data/output/**'],
      workspacePath,
    );
    expect(result.ok).toBe(true);
  });

  it('should reject traversal that tries to escape via symlink-like paths', () => {
    const result = validatePath(
      'data/../../../etc/shadow',
      ['data/**'],
      workspacePath,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL validation (validateUrl)
// ---------------------------------------------------------------------------

describe('validateUrl', () => {
  const permissions = {
    network: {
      domains: ['api.example.com', '*.github.com'],
      protocols: ['https'],
    },
  };

  it('should allow requests to declared domains', () => {
    const result = validateUrl('https://api.example.com/data', permissions);
    expect(result.ok).toBe(true);
  });

  it('should allow wildcard subdomain matches', () => {
    const result = validateUrl('https://raw.github.com/file', permissions);
    expect(result.ok).toBe(true);
  });

  it('should reject undeclared domains', () => {
    const result = validateUrl('https://evil.com/data', permissions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not in allowed domains');
    }
  });

  it('should reject disallowed protocols', () => {
    const result = validateUrl('http://api.example.com/data', permissions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Protocol');
      expect(result.error).toContain('not allowed');
    }
  });

  it('should reject invalid URLs', () => {
    const result = validateUrl('not-a-url', permissions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid URL');
    }
  });

  it('should block private IP 10.x', () => {
    const result = validateUrl('https://10.0.0.1/data', permissions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Private/reserved address');
    }
  });

  it('should block private IP 172.16.x', () => {
    const result = validateUrl('https://172.16.0.1/data', permissions);
    expect(result.ok).toBe(false);
  });

  it('should block private IP 192.168.x', () => {
    const result = validateUrl('https://192.168.1.1/data', permissions);
    expect(result.ok).toBe(false);
  });

  it('should block loopback 127.x', () => {
    const result = validateUrl('https://127.0.0.1/data', permissions);
    expect(result.ok).toBe(false);
  });

  it('should block localhost', () => {
    const result = validateUrl('https://localhost/data', permissions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('localhost blocked');
    }
  });

  it('should reject when no network permissions declared', () => {
    const result = validateUrl('https://api.example.com/data', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No network permissions declared');
    }
  });

  it('should allow wildcard * domain', () => {
    const result = validateUrl('https://anything.com/data', {
      network: { domains: ['*'], protocols: ['https'] },
    });
    expect(result.ok).toBe(true);
  });

  it('should default to https protocol when not specified', () => {
    const result = validateUrl('https://api.example.com/data', {
      network: { domains: ['api.example.com'] },
    });
    expect(result.ok).toBe(true);

    const httpResult = validateUrl('http://api.example.com/data', {
      network: { domains: ['api.example.com'] },
    });
    expect(httpResult.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Private IP detection (isPrivateIp)
// ---------------------------------------------------------------------------

describe('isPrivateIp', () => {
  it('should detect 10.x.x.x range', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
  });

  it('should detect 172.16-31.x.x range', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    // 172.15.x should NOT be private
    expect(isPrivateIp('172.15.0.1')).toBe(false);
    // 172.32.x should NOT be private
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('should detect 192.168.x.x range', () => {
    expect(isPrivateIp('192.168.0.1')).toBe(true);
    expect(isPrivateIp('192.168.255.255')).toBe(true);
  });

  it('should detect 127.x.x.x loopback', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.255.255.255')).toBe(true);
  });

  it('should detect 0.x.x.x range', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('should detect 169.254.x.x link-local', () => {
    expect(isPrivateIp('169.254.0.1')).toBe(true);
    expect(isPrivateIp('169.254.255.255')).toBe(true);
  });

  it('should detect IPv6 loopback', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('should detect IPv6 link-local', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('should detect IPv4-mapped IPv6', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
  });

  it('should not flag public IPs as private', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS rebinding prevention (checkDnsRebinding)
// ---------------------------------------------------------------------------

describe('checkDnsRebinding', () => {
  it('should skip DNS check for IPv4 addresses', async () => {
    const result = await checkDnsRebinding('93.184.216.34');
    expect(result.ok).toBe(true);
  });

  it('should skip DNS check for IPv6 addresses', async () => {
    const result = await checkDnsRebinding('::1');
    expect(result.ok).toBe(true);
  });

  it('should detect hostname resolving to private IP', async () => {
    const mockResolver: DnsResolver = () =>
      Promise.resolve([{ address: '10.0.0.1', family: 4 }]);

    const result = await checkDnsRebinding('evil-rebind.example.com', mockResolver);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('DNS rebinding detected');
      expect(result.error).toContain('10.0.0.1');
    }
  });

  it('should allow hostname resolving to public IP', async () => {
    const mockResolver: DnsResolver = () =>
      Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

    const result = await checkDnsRebinding('example.com', mockResolver);
    expect(result.ok).toBe(true);
  });

  it('should detect rebinding to 127.0.0.1', async () => {
    const mockResolver: DnsResolver = () =>
      Promise.resolve([{ address: '127.0.0.1', family: 4 }]);

    const result = await checkDnsRebinding('rebind-loopback.example.com', mockResolver);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('DNS rebinding');
      expect(result.error).toContain('127.0.0.1');
    }
  });

  it('should detect rebinding to 192.168.x.x', async () => {
    const mockResolver: DnsResolver = () =>
      Promise.resolve([{ address: '192.168.1.1', family: 4 }]);

    const result = await checkDnsRebinding('sneaky.example.com', mockResolver);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('DNS rebinding');
    }
  });

  it('should check all resolved addresses (multi-A record)', async () => {
    const mockResolver: DnsResolver = () =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]);

    const result = await checkDnsRebinding('multi-a.example.com', mockResolver);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('DNS rebinding');
      expect(result.error).toContain('10.0.0.1');
    }
  });

  it('should handle DNS resolution failure gracefully', async () => {
    const mockResolver: DnsResolver = () =>
      Promise.reject(new Error('ENOTFOUND'));

    const result = await checkDnsRebinding('nonexistent.invalid', mockResolver);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('DNS resolution failed');
    }
  });
});

// ---------------------------------------------------------------------------
// GearContextImpl — File operations respect declared paths
// ---------------------------------------------------------------------------

describe('GearContextImpl file operations', () => {
  it('should read files within declared read paths', async () => {
    const ctx = createGearContext(createTestConfig());
    const content = await ctx.readFile('data/input/test.txt');
    expect(content.toString('utf-8')).toBe('hello world');
  });

  it('should reject reading files outside declared read paths', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.readFile('secret/hidden.txt')).rejects.toThrow(
      /readFile denied/,
    );
  });

  it('should reject reading files with path traversal', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.readFile('../../../etc/passwd')).rejects.toThrow(
      /readFile denied/,
    );
  });

  it('should write files within declared write paths', async () => {
    const ctx = createGearContext(createTestConfig());
    const content = Buffer.from('output data');
    await ctx.writeFile('data/output/result.txt', content);

    const written = readFileSync(
      join(workspacePath, 'data', 'output', 'result.txt'),
      'utf-8',
    );
    expect(written).toBe('output data');
  });

  it('should create parent directories when writing', async () => {
    const ctx = createGearContext(createTestConfig());
    const content = Buffer.from('nested output');
    await ctx.writeFile('data/output/deep/nested/file.txt', content);

    expect(
      existsSync(join(workspacePath, 'data', 'output', 'deep', 'nested', 'file.txt')),
    ).toBe(true);
  });

  it('should reject writing files outside declared write paths', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(
      ctx.writeFile('data/input/inject.txt', Buffer.from('bad')),
    ).rejects.toThrow(/writeFile denied/);
  });

  it('should reject writing with path traversal', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(
      ctx.writeFile('../../root/evil.sh', Buffer.from('rm -rf /')),
    ).rejects.toThrow(/writeFile denied/);
  });

  it('should list files within declared read paths', async () => {
    const ctx = createGearContext(createTestConfig());
    const files = await ctx.listFiles('data/input');
    expect(files).toContain('test.txt');
  });

  it('should mark directories with trailing slash in listFiles', async () => {
    // Create a subdirectory
    mkdirSync(join(workspacePath, 'data', 'input', 'subdir'), { recursive: true });
    const ctx = createGearContext(createTestConfig());
    const files = await ctx.listFiles('data/input');
    expect(files).toContain('subdir/');
  });

  it('should reject listing files outside declared read paths', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.listFiles('secret')).rejects.toThrow(/listFiles denied/);
  });
});

// ---------------------------------------------------------------------------
// GearContextImpl — Secret ACL enforcement
// ---------------------------------------------------------------------------

describe('GearContextImpl secret ACL', () => {
  it('should allow access to declared secrets', async () => {
    const getSecret = vi.fn(
      (_gearId: string, name: string) => {
        if (name === 'api_key') return Promise.resolve('my-api-key');
        return Promise.resolve(undefined);
      },
    );

    const ctx = createGearContext(
      createTestConfig({ getSecret }),
    );

    const value = await ctx.getSecret('api_key');
    expect(value).toBe('my-api-key');
    expect(getSecret).toHaveBeenCalledWith('test-gear', 'api_key');
  });

  it('should reject access to undeclared secrets', async () => {
    const getSecret = vi.fn(() => Promise.resolve('leaked'));
    const ctx = createGearContext(
      createTestConfig({ getSecret }),
    );

    await expect(ctx.getSecret('undeclared_secret')).rejects.toThrow(
      /not declared in Gear/,
    );
    // getSecret should not even be called for undeclared secrets
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('should return undefined when secret provider is not configured', async () => {
    const ctx = createGearContext(
      createTestConfig({ getSecret: undefined }),
    );

    const value = await ctx.getSecret('api_key');
    expect(value).toBeUndefined();
  });

  it('should enforce ACL even with permissive secret provider', async () => {
    const getSecret = vi.fn(() => Promise.resolve('anything'));
    const ctx = createGearContext(
      createTestConfig({
        manifest: createTestManifest({ permissions: { secrets: ['only_this'] } }),
        getSecret,
      }),
    );

    // 'api_key' is not in the manifest's secrets list
    await expect(ctx.getSecret('api_key')).rejects.toThrow(
      /not declared in Gear/,
    );
  });

  it('should reject secrets when manifest has no secrets permissions', async () => {
    const getSecret = vi.fn(() => Promise.resolve('leaked'));
    const ctx = createGearContext(
      createTestConfig({
        manifest: createTestManifest({ permissions: {} }),
        getSecret,
      }),
    );

    await expect(ctx.getSecret('any_secret')).rejects.toThrow(
      /not declared in Gear/,
    );
  });
});

// ---------------------------------------------------------------------------
// GearContextImpl — Network requests
// ---------------------------------------------------------------------------

describe('GearContextImpl fetch', () => {
  it('should reject fetch to undeclared domain', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.fetch('https://evil.com/data')).rejects.toThrow(
      /fetch denied/,
    );
  });

  it('should reject fetch to private IP', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.fetch('https://10.0.0.1/data')).rejects.toThrow(
      /fetch denied/,
    );
  });

  it('should reject fetch to localhost', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.fetch('https://localhost/data')).rejects.toThrow(
      /fetch denied/,
    );
  });

  it('should reject fetch with disallowed protocol', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.fetch('http://api.example.com/data')).rejects.toThrow(
      /fetch denied/,
    );
  });

  it('should reject fetch with no network permissions', async () => {
    const ctx = createGearContext(
      createTestConfig({
        manifest: createTestManifest({ permissions: { filesystem: { read: ['**'] } } }),
      }),
    );
    await expect(ctx.fetch('https://api.example.com/data')).rejects.toThrow(
      /fetch denied.*No network permissions/,
    );
  });

  it('should reject fetch to 127.0.0.1', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.fetch('https://127.0.0.1:8080/api')).rejects.toThrow(
      /fetch denied/,
    );
  });

  it('should reject fetch to 192.168.x.x', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.fetch('https://192.168.1.1/admin')).rejects.toThrow(
      /fetch denied/,
    );
  });

  it('should reject fetch to 172.16.x.x', async () => {
    const ctx = createGearContext(createTestConfig());
    await expect(ctx.fetch('https://172.16.0.1/internal')).rejects.toThrow(
      /fetch denied/,
    );
  });
});

// ---------------------------------------------------------------------------
// GearContextImpl — Sub-job creation routes through Axis
// ---------------------------------------------------------------------------

describe('GearContextImpl createSubJob', () => {
  it('should route sub-job creation through the configured creator', async () => {
    const mockResult: JobResult = {
      jobId: 'sub-job-1',
      status: 'completed',
      result: { data: 'sub-job output' },
    };
    const subJobCreator = vi.fn(() => Promise.resolve(mockResult));

    const ctx = createGearContext(
      createTestConfig({ createSubJob: subJobCreator }),
    );

    const result = await ctx.createSubJob('Process the file');
    expect(result).toEqual(mockResult);
    expect(subJobCreator).toHaveBeenCalledWith('Process the file');
  });

  it('should throw when no sub-job creator is configured', async () => {
    const ctx = createGearContext(
      createTestConfig({ createSubJob: undefined }),
    );

    await expect(ctx.createSubJob('Do something')).rejects.toThrow(
      /createSubJob not available/,
    );
  });

  it('should propagate errors from sub-job creator', async () => {
    const subJobCreator = vi.fn(() =>
      Promise.reject(new Error('Axis unavailable')),
    );

    const ctx = createGearContext(
      createTestConfig({ createSubJob: subJobCreator }),
    );

    await expect(ctx.createSubJob('Failing task')).rejects.toThrow(
      'Axis unavailable',
    );
  });
});

// ---------------------------------------------------------------------------
// GearContextImpl — Log and progress
// ---------------------------------------------------------------------------

describe('GearContextImpl log and progress', () => {
  it('should forward log messages to the log sink', () => {
    const onLog = vi.fn();
    const ctx = createGearContext(createTestConfig({ onLog }));

    ctx.log('Processing step 1');
    ctx.log('Processing step 2');

    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledWith('test-gear', 'Processing step 1');
    expect(onLog).toHaveBeenCalledWith('test-gear', 'Processing step 2');
  });

  it('should not throw when no log sink is configured', () => {
    const ctx = createGearContext(createTestConfig({ onLog: undefined }));
    expect(() => { ctx.log('silent log'); }).not.toThrow();
  });

  it('should forward progress updates to the progress sink', () => {
    const onProgress = vi.fn();
    const ctx = createGearContext(createTestConfig({ onProgress }));

    ctx.progress(50, 'halfway done');

    expect(onProgress).toHaveBeenCalledWith(50, 'halfway done');
  });

  it('should clamp progress to 0-100 range', () => {
    const onProgress = vi.fn();
    const ctx = createGearContext(createTestConfig({ onProgress }));

    ctx.progress(-10, 'underflow');
    expect(onProgress).toHaveBeenCalledWith(0, 'underflow');

    ctx.progress(150, 'overflow');
    expect(onProgress).toHaveBeenCalledWith(100, 'overflow');
  });

  it('should not throw when no progress sink is configured', () => {
    const ctx = createGearContext(createTestConfig({ onProgress: undefined }));
    expect(() => { ctx.progress(50); }).not.toThrow();
  });

  it('should allow progress without message', () => {
    const onProgress = vi.fn();
    const ctx = createGearContext(createTestConfig({ onProgress }));

    ctx.progress(75);
    expect(onProgress).toHaveBeenCalledWith(75, undefined);
  });
});

// ---------------------------------------------------------------------------
// GearContextImpl — Params immutability
// ---------------------------------------------------------------------------

describe('GearContextImpl params', () => {
  it('should expose params as a frozen object', () => {
    const ctx = createGearContext(
      createTestConfig({ params: { key: 'value', nested: { a: 1 } } }),
    );

    expect(ctx.params).toEqual({ key: 'value', nested: { a: 1 } });
    expect(Object.isFrozen(ctx.params)).toBe(true);
  });

  it('should not allow modification of params', () => {
    const ctx = createGearContext(createTestConfig({ params: { key: 'value' } }));

    expect(() => {
      (ctx.params as unknown as Record<string, unknown>)['key'] = 'modified';
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

describe('createGearContext', () => {
  it('should return a GearContextImpl instance', () => {
    const ctx = createGearContext(createTestConfig());
    expect(ctx).toBeInstanceOf(GearContextImpl);
  });

  it('should set params from config', () => {
    const ctx = createGearContext(
      createTestConfig({ params: { a: 1, b: 'two' } }),
    );
    expect(ctx.params).toEqual({ a: 1, b: 'two' });
  });
});
