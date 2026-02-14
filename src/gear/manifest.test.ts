// @meridian/gear — Manifest validation tests (Phase 5.1)

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { GearManifest } from '@meridian/shared';

import {
  validateManifest,
  computeChecksum,
  computeChecksumFromBuffer,
} from './manifest.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createValidManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'file-manager',
    name: 'File Manager',
    version: '1.0.0',
    description: 'Read, write, and list files in the workspace',
    author: 'Meridian',
    license: 'Apache-2.0',
    origin: 'builtin',
    checksum: 'abc123def456',
    actions: [
      {
        name: 'read_file',
        description: 'Read the contents of a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        returns: {
          type: 'object',
          properties: { content: { type: 'string' } },
        },
        riskLevel: 'low',
      },
    ],
    permissions: {
      filesystem: {
        read: ['workspace/**'],
        write: ['workspace/**'],
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: validateManifest
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  describe('valid manifests', () => {
    it('should accept a valid manifest with all required fields', () => {
      const manifest = createValidManifest();
      const result = validateManifest(manifest);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('file-manager');
        expect(result.value.name).toBe('File Manager');
      }
    });

    it('should apply default resource limits when resources are omitted', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).resources;

      const result = validateManifest(manifest);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.resources?.maxMemoryMb).toBe(256);
        expect(result.value.resources?.maxCpuPercent).toBe(50);
        expect(result.value.resources?.timeoutMs).toBe(300_000);
      }
    });

    it('should preserve custom resource limits', () => {
      const manifest = createValidManifest({
        resources: {
          maxMemoryMb: 512,
          maxCpuPercent: 80,
          timeoutMs: 60_000,
          maxNetworkBytesPerCall: 10_000_000,
        },
      });

      const result = validateManifest(manifest);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.resources?.maxMemoryMb).toBe(512);
        expect(result.value.resources?.maxCpuPercent).toBe(80);
        expect(result.value.resources?.timeoutMs).toBe(60_000);
        expect(result.value.resources?.maxNetworkBytesPerCall).toBe(10_000_000);
      }
    });

    it('should accept a manifest with optional fields', () => {
      const manifest = createValidManifest({
        repository: 'https://github.com/meridian/file-manager',
        signature: 'sig-abc123',
        draft: false,
      });

      const result = validateManifest(manifest);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.repository).toBe('https://github.com/meridian/file-manager');
        expect(result.value.signature).toBe('sig-abc123');
        expect(result.value.draft).toBe(false);
      }
    });

    it('should accept manifests with network permissions', () => {
      const manifest = createValidManifest({
        permissions: {
          network: {
            domains: ['api.example.com', '*.google.com'],
            protocols: ['https'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(true);
    });

    it('should accept manifests with secret permissions', () => {
      const manifest = createValidManifest({
        permissions: {
          secrets: ['GMAIL_API_KEY', 'SMTP_PASSWORD'],
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(true);
    });

    it('should accept manifests with multiple actions', () => {
      const manifest = createValidManifest({
        actions: [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: {} },
            returns: { type: 'object', properties: {} },
            riskLevel: 'low',
          },
          {
            name: 'write_file',
            description: 'Write a file',
            parameters: { type: 'object', properties: {} },
            returns: { type: 'object', properties: {} },
            riskLevel: 'medium',
          },
        ],
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(true);
    });

    it('should accept all valid risk levels', () => {
      for (const riskLevel of ['low', 'medium', 'high', 'critical'] as const) {
        const manifest = createValidManifest({
          actions: [{
            name: 'test_action',
            description: 'Test',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel,
          }],
        });

        const result = validateManifest(manifest);
        expect(result.ok).toBe(true);
      }
    });

    it('should accept all valid origins', () => {
      for (const origin of ['builtin', 'user', 'journal'] as const) {
        const manifest = createValidManifest({ origin });
        const result = validateManifest(manifest);
        expect(result.ok).toBe(true);
      }
    });
  });

  describe('missing required fields', () => {
    it('should reject non-object input', () => {
      const result = validateManifest('not an object');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error[0]?.message).toContain('non-null object');
      }
    });

    it('should reject null input', () => {
      const result = validateManifest(null);
      expect(result.ok).toBe(false);
    });

    it('should reject array input', () => {
      const result = validateManifest([]);
      expect(result.ok).toBe(false);
    });

    it('should reject manifest with missing id', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).id;

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'id')).toBe(true);
      }
    });

    it('should reject manifest with missing name', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).name;

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'name')).toBe(true);
      }
    });

    it('should reject manifest with missing version', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).version;

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'version')).toBe(true);
      }
    });

    it('should reject manifest with missing actions', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).actions;

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'actions')).toBe(true);
      }
    });

    it('should reject manifest with missing permissions', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).permissions;

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'permissions')).toBe(true);
      }
    });

    it('should reject manifest with missing origin', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).origin;

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'origin')).toBe(true);
      }
    });

    it('should reject manifest with missing checksum', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>).checksum;

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'checksum')).toBe(true);
      }
    });

    it('should reject manifest with empty actions array', () => {
      const manifest = createValidManifest({ actions: [] });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'actions')).toBe(true);
      }
    });
  });

  describe('invalid field values', () => {
    it('should reject invalid Gear ID format', () => {
      const manifest = createValidManifest({ id: 'Invalid-ID!' });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'id' && i.type === 'invalid_field')).toBe(true);
      }
    });

    it('should reject Gear ID starting with a number', () => {
      const manifest = createValidManifest({ id: '1bad-id' });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });

    it('should reject invalid semver version', () => {
      const manifest = createValidManifest({ version: 'not-semver' });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.type === 'invalid_version')).toBe(true);
      }
    });

    it('should reject unknown license', () => {
      const manifest = createValidManifest({ license: 'UNKNOWN-LICENSE-123' });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'license')).toBe(true);
      }
    });

    it('should reject invalid origin', () => {
      const manifest = createValidManifest();
      (manifest as unknown as Record<string, unknown>).origin = 'external';

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'origin')).toBe(true);
      }
    });

    it('should reject invalid risk level in actions', () => {
      const manifest = createValidManifest({
        actions: [{
          name: 'test_action',
          description: 'Test',
          parameters: { type: 'object' },
          returns: { type: 'object' },
          riskLevel: 'extreme' as 'low',
        }],
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field.includes('riskLevel'))).toBe(true);
      }
    });

    it('should reject duplicate action names', () => {
      const manifest = createValidManifest({
        actions: [
          {
            name: 'duplicate_name',
            description: 'First',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel: 'low',
          },
          {
            name: 'duplicate_name',
            description: 'Second',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel: 'low',
          },
        ],
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.type === 'duplicate_action')).toBe(true);
      }
    });

    it('should reject action names with uppercase', () => {
      const manifest = createValidManifest({
        actions: [{
          name: 'BadName',
          description: 'Test',
          parameters: { type: 'object' },
          returns: { type: 'object' },
          riskLevel: 'low',
        }],
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });
  });

  describe('invalid permission patterns', () => {
    it('should reject filesystem paths with directory traversal', () => {
      const manifest = createValidManifest({
        permissions: {
          filesystem: {
            read: ['workspace/../etc/passwd'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.message.includes('..'))).toBe(true);
      }
    });

    it('should reject empty filesystem paths', () => {
      const manifest = createValidManifest({
        permissions: {
          filesystem: {
            read: [''],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });

    it('should reject invalid network domain patterns', () => {
      const manifest = createValidManifest({
        permissions: {
          network: {
            domains: ['not a domain!'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.message.includes('Invalid domain'))).toBe(true);
      }
    });

    it('should reject invalid network protocols', () => {
      const manifest = createValidManifest({
        permissions: {
          network: {
            protocols: ['ftp'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.message.includes('Invalid protocol'))).toBe(true);
      }
    });

    it('should reject non-string secret names', () => {
      const manifest = createValidManifest({
        permissions: {
          secrets: [123 as unknown as string],
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });

    it('should reject non-boolean shell permission', () => {
      const manifest = createValidManifest({
        permissions: {
          shell: 'yes' as unknown as boolean,
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });
  });

  describe('invalid resources', () => {
    it('should reject negative memory limit', () => {
      const manifest = createValidManifest({
        resources: { maxMemoryMb: -256 },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((i) => i.field === 'resources.maxMemoryMb')).toBe(true);
      }
    });

    it('should reject zero CPU limit', () => {
      const manifest = createValidManifest({
        resources: { maxCpuPercent: 0 },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });

    it('should reject CPU limit over 100', () => {
      const manifest = createValidManifest({
        resources: { maxCpuPercent: 150 },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });

    it('should reject zero timeout', () => {
      const manifest = createValidManifest({
        resources: { timeoutMs: 0 },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });

    it('should reject negative network bytes limit', () => {
      const manifest = createValidManifest({
        resources: { maxNetworkBytesPerCall: -1 },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
    });
  });

  describe('vulnerability scanning', () => {
    it('should flag shell + network access combination', () => {
      const manifest = createValidManifest({
        origin: 'user',
        permissions: {
          shell: true,
          network: {
            domains: ['evil.com'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.error.some((i) => i.type === 'vulnerability_detected' && i.field === 'VULN_SHELL_WITH_NETWORK'),
        ).toBe(true);
      }
    });

    it('should flag wildcard filesystem access for non-builtin Gear', () => {
      const manifest = createValidManifest({
        origin: 'user',
        permissions: {
          filesystem: {
            read: ['**'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.error.some((i) => i.field === 'VULN_WILDCARD_FILESYSTEM'),
        ).toBe(true);
      }
    });

    it('should allow wildcard filesystem access for builtin Gear', () => {
      const manifest = createValidManifest({
        origin: 'builtin',
        permissions: {
          filesystem: {
            read: ['**'],
            write: ['**'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(true);
    });

    it('should flag wildcard network access for non-builtin Gear', () => {
      const manifest = createValidManifest({
        origin: 'user',
        permissions: {
          network: {
            domains: ['*'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.error.some((i) => i.field === 'VULN_WILDCARD_NETWORK'),
        ).toBe(true);
      }
    });

    it('should allow wildcard network access for builtin Gear', () => {
      const manifest = createValidManifest({
        origin: 'builtin',
        permissions: {
          network: {
            domains: ['*'],
          },
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(true);
    });

    it('should flag excessive secrets', () => {
      const secrets = Array.from({ length: 11 }, (_, i) => `SECRET_${i}`);
      const manifest = createValidManifest({
        permissions: { secrets },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.error.some((i) => i.field === 'VULN_EXCESSIVE_SECRETS'),
        ).toBe(true);
      }
    });

    it('should flag non-builtin shell access', () => {
      const manifest = createValidManifest({
        origin: 'user',
        permissions: {
          shell: true,
        },
      });

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.error.some((i) => i.field === 'VULN_SHELL_DEFAULT_ENABLED'),
        ).toBe(true);
      }
    });

    it('should not flag builtin shell access', () => {
      const manifest = createValidManifest({
        id: 'shell',
        origin: 'builtin',
        permissions: {
          shell: true,
        },
      });

      // Should pass — builtin shell is expected
      const result = validateManifest(manifest);
      expect(result.ok).toBe(true);
    });
  });

  describe('non-short-circuiting', () => {
    it('should collect multiple issues in a single validation', () => {
      const manifest = {
        id: 'INVALID!',
        name: '',
        version: 'bad',
        description: '',
        author: '',
        license: 'INVALID',
        origin: 'unknown',
        checksum: '',
        actions: [],
        permissions: null,
      };

      const result = validateManifest(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Should have multiple issues
        expect(result.error.length).toBeGreaterThan(3);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: checksum computation
// ---------------------------------------------------------------------------

describe('computeChecksum', () => {
  let tempDir: string;
  let testFilePath: string;
  const testContent = 'Hello, Meridian Gear!';

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'meridian-gear-test-'));
    testFilePath = join(tempDir, 'test-gear.js');
    writeFileSync(testFilePath, testContent);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should compute SHA-256 checksum of a file', async () => {
    const checksum = await computeChecksum(testFilePath);

    // Verify against Node.js built-in
    const expected = createHash('sha256').update(testContent).digest('hex');
    expect(checksum).toBe(expected);
  });

  it('should produce consistent checksums for the same file', async () => {
    const checksum1 = await computeChecksum(testFilePath);
    const checksum2 = await computeChecksum(testFilePath);
    expect(checksum1).toBe(checksum2);
  });

  it('should produce different checksums for different content', async () => {
    const otherPath = join(tempDir, 'other-gear.js');
    writeFileSync(otherPath, 'Different content');

    const checksum1 = await computeChecksum(testFilePath);
    const checksum2 = await computeChecksum(otherPath);
    expect(checksum1).not.toBe(checksum2);
  });

  it('should reject non-existent file paths', async () => {
    await expect(computeChecksum('/nonexistent/file.js')).rejects.toThrow();
  });
});

describe('computeChecksumFromBuffer', () => {
  it('should compute SHA-256 checksum of a Buffer', () => {
    const data = Buffer.from('Hello, Meridian Gear!');
    const checksum = computeChecksumFromBuffer(data);

    const expected = createHash('sha256').update(data).digest('hex');
    expect(checksum).toBe(expected);
  });

  it('should produce consistent checksums for the same data', () => {
    const data = Buffer.from('Test data');
    const checksum1 = computeChecksumFromBuffer(data);
    const checksum2 = computeChecksumFromBuffer(data);
    expect(checksum1).toBe(checksum2);
  });
});
