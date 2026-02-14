/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
// @meridian/gear — Gear SDK Testing Utilities tests (Phase 11.2)

import { describe, it, expect, vi } from 'vitest';

import type { GearContext } from '@meridian/shared';

import {
  createMockContext,
  getMockTestData,
  createTestManifest,
  validateHandler,
} from './testing.js';
import type { GearResult } from './types.js';

// ---------------------------------------------------------------------------
// Tests: createMockContext
// ---------------------------------------------------------------------------

describe('createMockContext', () => {
  it('should create a context with default params', () => {
    const ctx = createMockContext();

    expect(ctx.params).toEqual({});
  });

  it('should allow overriding params', () => {
    const ctx = createMockContext({
      params: { path: '/test.txt', encoding: 'utf-8' },
    });

    expect(ctx.params).toEqual({ path: '/test.txt', encoding: 'utf-8' });
  });

  it('should provide a working log function', () => {
    const ctx = createMockContext();

    ctx.log('hello');
    ctx.log('world');

    const testData = getMockTestData(ctx);
    expect(testData).not.toBeNull();
    expect(testData!.logs).toEqual(['hello', 'world']);
  });

  it('should provide a working progress function', () => {
    const ctx = createMockContext();

    ctx.progress(0, 'Starting');
    ctx.progress(50, 'Halfway');
    ctx.progress(100, 'Done');

    const testData = getMockTestData(ctx);
    expect(testData!.progressUpdates).toHaveLength(3);
    expect(testData!.progressUpdates[0]).toEqual({
      percent: 0,
      message: 'Starting',
    });
    expect(testData!.progressUpdates[2]).toEqual({
      percent: 100,
      message: 'Done',
    });
  });

  it('should track written files', async () => {
    const ctx = createMockContext();

    await ctx.writeFile('/test.txt', Buffer.from('hello'));
    await ctx.writeFile('/other.txt', Buffer.from('world'));

    const testData = getMockTestData(ctx);
    expect(testData!.writtenFiles.size).toBe(2);
    expect(testData!.writtenFiles.get('/test.txt')!.toString()).toBe('hello');
  });

  it('should return empty buffer from readFile by default', async () => {
    const ctx = createMockContext();
    const data = await ctx.readFile('/any/path');

    expect(data).toEqual(Buffer.from(''));
  });

  it('should return undefined from getSecret by default', async () => {
    const ctx = createMockContext();
    const secret = await ctx.getSecret('API_KEY');

    expect(secret).toBeUndefined();
  });

  it('should return empty array from listFiles by default', async () => {
    const ctx = createMockContext();
    const files = await ctx.listFiles('/any/dir');

    expect(files).toEqual([]);
  });

  it('should return 200 response from fetch by default', async () => {
    const ctx = createMockContext();
    const response = await ctx.fetch('https://example.com');

    expect(response.status).toBe(200);
    expect(response.body).toBe('');
  });

  it('should return completed job from createSubJob', async () => {
    const ctx = createMockContext();
    const result = await ctx.createSubJob('Test job');

    expect(result.status).toBe('completed');
    expect(result.jobId).toBeDefined();
  });

  it('should allow overriding individual methods', async () => {
    const customReadFile = vi.fn().mockResolvedValue(Buffer.from('custom'));

    const ctx = createMockContext({
      readFile: customReadFile,
    });

    const data = await ctx.readFile('/custom.txt');
    expect(data.toString()).toBe('custom');
    expect(customReadFile).toHaveBeenCalledWith('/custom.txt');
  });

  it('should allow overriding getSecret', async () => {
    const ctx = createMockContext({
      getSecret: async (name) => {
        if (name === 'API_KEY') return 'secret-123';
        return undefined;
      },
    });

    expect(await ctx.getSecret('API_KEY')).toBe('secret-123');
    expect(await ctx.getSecret('OTHER')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: getMockTestData
// ---------------------------------------------------------------------------

describe('getMockTestData', () => {
  it('should return test data from mock context', () => {
    const ctx = createMockContext();
    const data = getMockTestData(ctx);

    expect(data).not.toBeNull();
    expect(data!.logs).toEqual([]);
    expect(data!.progressUpdates).toEqual([]);
    expect(data!.writtenFiles).toBeInstanceOf(Map);
  });

  it('should return null for non-mock context', () => {
    const fakeCtx = { params: {} } as GearContext;
    const data = getMockTestData(fakeCtx);

    expect(data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: createTestManifest
// ---------------------------------------------------------------------------

describe('createTestManifest', () => {
  it('should create a valid manifest with defaults', () => {
    const manifest = createTestManifest();

    expect(manifest.id).toBe('test-gear');
    expect(manifest.name).toBe('Test Gear');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.origin).toBe('user');
    expect(manifest.actions).toHaveLength(1);
    expect(manifest.actions[0]!.name).toBe('test_action');
    expect(manifest.permissions).toEqual({});
    expect(manifest.checksum).toBeDefined();
  });

  it('should allow overriding fields', () => {
    const manifest = createTestManifest({
      id: 'my-gear',
      name: 'My Gear',
      version: '2.0.0',
      origin: 'builtin',
    });

    expect(manifest.id).toBe('my-gear');
    expect(manifest.name).toBe('My Gear');
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.origin).toBe('builtin');
  });

  it('should allow overriding actions', () => {
    const manifest = createTestManifest({
      actions: [
        {
          name: 'custom_action',
          description: 'Custom',
          parameters: { type: 'object' },
          returns: { type: 'object' },
          riskLevel: 'high',
        },
      ],
    });

    expect(manifest.actions).toHaveLength(1);
    expect(manifest.actions[0]!.name).toBe('custom_action');
    expect(manifest.actions[0]!.riskLevel).toBe('high');
  });

  it('should allow overriding permissions', () => {
    const manifest = createTestManifest({
      permissions: {
        filesystem: { read: ['workspace/**'] },
        network: { domains: ['api.example.com'] },
      },
    });

    expect(manifest.permissions.filesystem?.read).toEqual(['workspace/**']);
    expect(manifest.permissions.network?.domains).toEqual(['api.example.com']);
  });

  it('should include all required GearManifest fields', () => {
    const manifest = createTestManifest();

    // Check all required fields are present
    expect(manifest.id).toBeDefined();
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.author).toBeDefined();
    expect(manifest.license).toBeDefined();
    expect(manifest.origin).toBeDefined();
    expect(manifest.checksum).toBeDefined();
    expect(manifest.actions).toBeDefined();
    expect(manifest.permissions).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: validateHandler
// ---------------------------------------------------------------------------

describe('validateHandler', () => {
  const manifest = createTestManifest({
    actions: [
      {
        name: 'greet',
        description: 'Greet someone',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        returns: {
          type: 'object',
          properties: { greeting: { type: 'string' } },
        },
        riskLevel: 'low',
      },
    ],
  });

  it('should validate a successful handler', async () => {
    const handler = async (ctx: GearContext): Promise<GearResult> => {
      const name = ctx.params['name'] as string;
      return { success: true, data: { greeting: `Hello, ${name}!` } };
    };

    const result = await validateHandler(manifest, 'greet', handler, {
      name: 'Alice',
    });

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.success).toBe(true);
    expect(result.result!.data!['greeting']).toBe('Hello, Alice!');
  });

  it('should validate a handler that returns failure', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      return { success: false, error: 'Name is required' };
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(true);
    expect(result.result!.success).toBe(false);
    expect(result.result!.error).toBe('Name is required');
  });

  it('should fail for unknown action', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      return { success: true };
    };

    const result = await validateHandler(
      manifest,
      'nonexistent_action',
      handler,
      {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found in manifest');
  });

  it('should fail when handler throws', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      throw new Error('Something went wrong');
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('threw an exception');
    expect(result.error).toContain('Something went wrong');
  });

  it('should fail when handler returns non-object', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      return 'not-an-object' as unknown as GearResult;
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-null object');
  });

  it('should fail when handler returns null', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      return null as unknown as GearResult;
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-null object');
  });

  it('should fail when handler result has non-boolean success', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      return { success: 'yes' as unknown as boolean };
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('boolean');
  });

  it('should fail when handler result has non-object data', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      return {
        success: true,
        data: 'not-object' as unknown as Record<string, unknown>,
      };
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('data');
  });

  it('should fail when handler result has non-string error', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      return {
        success: false,
        error: 42 as unknown as string,
      };
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('error');
  });

  it('should pass test input to handler via context params', async () => {
    const handler = async (ctx: GearContext): Promise<GearResult> => {
      return {
        success: true,
        data: { received: ctx.params },
      };
    };

    const testInput = { name: 'Bob', age: 42 };
    const result = await validateHandler(
      manifest,
      'greet',
      handler,
      testInput,
    );

    expect(result.success).toBe(true);
    expect(result.result!.data!['received']).toEqual(testInput);
  });

  it('should handle handler that throws non-Error', async () => {
    const handler = async (_ctx: GearContext): Promise<GearResult> => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error throw handling
      throw 'string error';
    };

    const result = await validateHandler(manifest, 'greet', handler, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('string error');
  });
});
