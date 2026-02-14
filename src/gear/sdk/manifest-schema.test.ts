/* eslint-disable @typescript-eslint/no-non-null-assertion */
// @meridian/gear — Manifest Schema tests (Phase 11.2)

import { describe, it, expect } from 'vitest';

import type { GearManifest } from '@meridian/shared';

import {
  GEAR_MANIFEST_SCHEMA,
  validateManifest,
} from './manifest-schema.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createValidManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'test-gear',
    name: 'Test Gear',
    version: '1.0.0',
    description: 'A test Gear for validation',
    author: 'test-author',
    license: 'MIT',
    origin: 'user',
    checksum: 'sha256-abcdef',
    actions: [
      {
        name: 'test_action',
        description: 'A test action',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
        },
        returns: {
          type: 'object',
          properties: { output: { type: 'string' } },
        },
        riskLevel: 'low',
      },
    ],
    permissions: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: GEAR_MANIFEST_SCHEMA
// ---------------------------------------------------------------------------

describe('GEAR_MANIFEST_SCHEMA', () => {
  it('should be a valid JSON Schema object', () => {
    expect(GEAR_MANIFEST_SCHEMA['$schema']).toBeDefined();
    expect(GEAR_MANIFEST_SCHEMA['type']).toBe('object');
  });

  it('should declare all required fields', () => {
    const required = GEAR_MANIFEST_SCHEMA['required'] as string[];

    expect(required).toContain('id');
    expect(required).toContain('name');
    expect(required).toContain('version');
    expect(required).toContain('description');
    expect(required).toContain('author');
    expect(required).toContain('license');
    expect(required).toContain('actions');
    expect(required).toContain('permissions');
    expect(required).toContain('origin');
    expect(required).toContain('checksum');
  });

  it('should define properties for all required fields', () => {
    const properties = GEAR_MANIFEST_SCHEMA['properties'] as Record<
      string,
      unknown
    >;
    const required = GEAR_MANIFEST_SCHEMA['required'] as string[];

    for (const field of required) {
      expect(properties[field]).toBeDefined();
    }
  });

  it('should define id with pattern constraint', () => {
    const properties = GEAR_MANIFEST_SCHEMA['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const idSchema = properties['id']!;

    expect(idSchema['type']).toBe('string');
    expect(idSchema['pattern']).toBeDefined();
  });

  it('should define version with semver pattern', () => {
    const properties = GEAR_MANIFEST_SCHEMA['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const versionSchema = properties['version']!;

    expect(versionSchema['type']).toBe('string');
    expect(versionSchema['pattern']).toBeDefined();
  });

  it('should define origin as enum', () => {
    const properties = GEAR_MANIFEST_SCHEMA['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const originSchema = properties['origin']!;

    expect(originSchema['type']).toBe('string');
    expect(originSchema['enum']).toEqual(['builtin', 'user', 'journal']);
  });

  it('should define actions as array with minItems', () => {
    const properties = GEAR_MANIFEST_SCHEMA['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const actionsSchema = properties['actions']!;

    expect(actionsSchema['type']).toBe('array');
    expect(actionsSchema['minItems']).toBe(1);
  });

  it('should define action riskLevel as enum', () => {
    const properties = GEAR_MANIFEST_SCHEMA['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const actionsSchema = properties['actions'] as Record<string, unknown>;
    const items = actionsSchema['items'] as Record<string, unknown>;
    const itemProps = items['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const riskLevelSchema = itemProps['riskLevel']!;

    expect(riskLevelSchema['enum']).toEqual([
      'low',
      'medium',
      'high',
      'critical',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateManifest (schema-level)
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  describe('valid manifests', () => {
    it('should accept a valid manifest', () => {
      const result = validateManifest(createValidManifest());

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept manifests with optional fields', () => {
      const result = validateManifest(
        createValidManifest({
          repository: 'https://github.com/test/gear',
          signature: 'sig123',
          draft: true,
          resources: {
            maxMemoryMb: 512,
            maxCpuPercent: 80,
            timeoutMs: 60000,
          },
        }),
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept all valid origins', () => {
      for (const origin of ['builtin', 'user', 'journal'] as const) {
        const result = validateManifest(createValidManifest({ origin }));
        expect(result.valid).toBe(true);
      }
    });

    it('should accept all valid risk levels in actions', () => {
      for (const riskLevel of ['low', 'medium', 'high', 'critical'] as const) {
        const result = validateManifest(
          createValidManifest({
            actions: [
              {
                name: 'test_action',
                description: 'Test',
                parameters: { type: 'object' },
                returns: { type: 'object' },
                riskLevel,
              },
            ],
          }),
        );
        expect(result.valid).toBe(true);
      }
    });

    it('should accept versions with pre-release tags', () => {
      const result = validateManifest(
        createValidManifest({ version: '1.0.0-beta.1' }),
      );
      expect(result.valid).toBe(true);
    });

    it('should accept versions with build metadata', () => {
      const result = validateManifest(
        createValidManifest({ version: '1.0.0+build.123' }),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('missing required fields', () => {
    it('should reject non-object input', () => {
      const result = validateManifest('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('non-null object');
    });

    it('should reject null input', () => {
      const result = validateManifest(null);
      expect(result.valid).toBe(false);
    });

    it('should reject array input', () => {
      const result = validateManifest([]);
      expect(result.valid).toBe(false);
    });

    it('should report all missing required fields', () => {
      const result = validateManifest({});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(10);
      expect(result.errors.some((e) => e.includes('"id"'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"name"'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"version"'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"actions"'))).toBe(true);
    });

    it('should reject manifest with missing id', () => {
      const manifest = createValidManifest();
      delete (manifest as unknown as Record<string, unknown>)['id'];
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"id"'))).toBe(true);
    });
  });

  describe('invalid field values', () => {
    it('should reject invalid id format', () => {
      const result = validateManifest(
        createValidManifest({ id: 'INVALID-ID!' }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('id'))).toBe(true);
    });

    it('should reject id starting with a number', () => {
      const result = validateManifest(
        createValidManifest({ id: '1bad' }),
      );
      expect(result.valid).toBe(false);
    });

    it('should reject id over 64 characters', () => {
      const result = validateManifest(
        createValidManifest({ id: 'a'.repeat(65) }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('64'))).toBe(true);
    });

    it('should reject invalid version format', () => {
      const result = validateManifest(
        createValidManifest({ version: 'not-semver' }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('version'))).toBe(true);
    });

    it('should reject invalid origin', () => {
      const manifest = createValidManifest();
      (manifest as unknown as Record<string, unknown>)['origin'] = 'external';
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('origin'))).toBe(true);
    });

    it('should reject empty name', () => {
      const result = validateManifest(
        createValidManifest({ name: '' }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    });

    it('should reject name over 100 characters', () => {
      const result = validateManifest(
        createValidManifest({ name: 'a'.repeat(101) }),
      );
      expect(result.valid).toBe(false);
    });

    it('should reject non-string id', () => {
      const manifest = createValidManifest();
      (manifest as unknown as Record<string, unknown>)['id'] = 42;
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
    });
  });

  describe('invalid actions', () => {
    it('should reject empty actions array', () => {
      const result = validateManifest(
        createValidManifest({ actions: [] }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('actions'))).toBe(true);
    });

    it('should reject non-array actions', () => {
      const manifest = createValidManifest();
      (manifest as unknown as Record<string, unknown>)['actions'] = 'not-array';
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
    });

    it('should reject action with invalid name format', () => {
      const result = validateManifest(
        createValidManifest({
          actions: [
            {
              name: 'Bad-Name',
              description: 'Test',
              parameters: { type: 'object' },
              returns: { type: 'object' },
              riskLevel: 'low',
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    });

    it('should reject action with invalid risk level', () => {
      const result = validateManifest(
        createValidManifest({
          actions: [
            {
              name: 'test_action',
              description: 'Test',
              parameters: { type: 'object' },
              returns: { type: 'object' },
              riskLevel: 'extreme' as 'low',
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('riskLevel'))).toBe(true);
    });

    it('should reject duplicate action names', () => {
      const result = validateManifest(
        createValidManifest({
          actions: [
            {
              name: 'same_name',
              description: 'First',
              parameters: { type: 'object' },
              returns: { type: 'object' },
              riskLevel: 'low',
            },
            {
              name: 'same_name',
              description: 'Second',
              parameters: { type: 'object' },
              returns: { type: 'object' },
              riskLevel: 'low',
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('duplicated'))).toBe(true);
    });

    it('should reject action with non-object parameters', () => {
      const result = validateManifest(
        createValidManifest({
          actions: [
            {
              name: 'test_action',
              description: 'Test',
              parameters: 'not-object' as unknown as Record<string, unknown>,
              returns: { type: 'object' },
              riskLevel: 'low',
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('parameters'))).toBe(true);
    });

    it('should reject non-object action in array', () => {
      const manifest = createValidManifest();
      (manifest as unknown as Record<string, unknown>)['actions'] = ['not-an-object'];
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
    });
  });

  describe('invalid resources', () => {
    it('should reject negative memory limit', () => {
      const result = validateManifest(
        createValidManifest({ resources: { maxMemoryMb: -1 } }),
      );
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes('maxMemoryMb')),
      ).toBe(true);
    });

    it('should reject zero CPU percent', () => {
      const result = validateManifest(
        createValidManifest({ resources: { maxCpuPercent: 0 } }),
      );
      expect(result.valid).toBe(false);
    });

    it('should reject CPU percent over 100', () => {
      const result = validateManifest(
        createValidManifest({ resources: { maxCpuPercent: 150 } }),
      );
      expect(result.valid).toBe(false);
    });

    it('should reject zero timeout', () => {
      const result = validateManifest(
        createValidManifest({ resources: { timeoutMs: 0 } }),
      );
      expect(result.valid).toBe(false);
    });

    it('should reject negative network bytes', () => {
      const result = validateManifest(
        createValidManifest({
          resources: { maxNetworkBytesPerCall: -100 },
        }),
      );
      expect(result.valid).toBe(false);
    });

    it('should reject non-object resources', () => {
      const manifest = createValidManifest();
      (manifest as unknown as Record<string, unknown>)['resources'] = 'not-object';
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
    });
  });

  describe('non-short-circuiting', () => {
    it('should report multiple errors at once', () => {
      const result = validateManifest({
        id: '!!!',
        name: '',
        version: 'bad',
        origin: 'invalid',
        actions: [],
        permissions: 'bad',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(3);
    });
  });
});
