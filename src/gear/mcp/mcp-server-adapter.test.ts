/* eslint-disable @typescript-eslint/no-non-null-assertion */
// @meridian/gear — MCP Server Adapter tests (Phase 11.2)

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { GearManifest, GearAction, MCPToolDefinition } from '@meridian/shared';

import {
  gearActionToMCPTool,
  manifestToMCPTools,
  MCPServerAdapter,
} from './mcp-server-adapter.js';
import type { MCPRequest } from './mcp-server-adapter.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTestAction(overrides?: Partial<GearAction>): GearAction {
  return {
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
    ...overrides,
  };
}

function createTestManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'file-manager',
    name: 'File Manager',
    version: '1.0.0',
    description: 'Manage files in the workspace',
    author: 'Meridian',
    license: 'Apache-2.0',
    origin: 'builtin',
    checksum: 'abc123',
    actions: [createTestAction()],
    permissions: {
      filesystem: { read: ['workspace/**'] },
    },
    ...overrides,
  };
}

function buildRequest(overrides?: Partial<MCPRequest>): MCPRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: gearActionToMCPTool
// ---------------------------------------------------------------------------

describe('gearActionToMCPTool', () => {
  it('should convert a GearAction to an MCP tool definition', () => {
    const action = createTestAction();
    const tool = gearActionToMCPTool('file-manager', action);

    expect(tool.name).toBe('file-manager.read_file');
    expect(tool.description).toBe('Read the contents of a file');
    expect(tool.inputSchema).toEqual(action.parameters);
  });

  it('should use gear ID and action name as tool name', () => {
    const action = createTestAction({ name: 'write_file' });
    const tool = gearActionToMCPTool('my-gear', action);

    expect(tool.name).toBe('my-gear.write_file');
  });

  it('should preserve the full parameter schema', () => {
    const complexParams = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        encoding: { type: 'string', default: 'utf-8' },
      },
      required: ['path'],
    };
    const action = createTestAction({ parameters: complexParams });
    const tool = gearActionToMCPTool('gear', action);

    expect(tool.inputSchema).toEqual(complexParams);
  });
});

// ---------------------------------------------------------------------------
// Tests: manifestToMCPTools
// ---------------------------------------------------------------------------

describe('manifestToMCPTools', () => {
  it('should convert all actions from a manifest', () => {
    const manifest = createTestManifest({
      actions: [
        createTestAction({ name: 'read_file', description: 'Read' }),
        createTestAction({ name: 'write_file', description: 'Write' }),
        createTestAction({ name: 'delete_file', description: 'Delete' }),
      ],
    });

    const tools = manifestToMCPTools(manifest);

    expect(tools).toHaveLength(3);
    expect(tools[0]!.name).toBe('file-manager.read_file');
    expect(tools[1]!.name).toBe('file-manager.write_file');
    expect(tools[2]!.name).toBe('file-manager.delete_file');
  });

  it('should return empty array for manifest with no actions', () => {
    const manifest = createTestManifest({ actions: [] });
    const tools = manifestToMCPTools(manifest);
    expect(tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: MCPServerAdapter
// ---------------------------------------------------------------------------

describe('MCPServerAdapter', () => {
  let adapter: MCPServerAdapter;
  const manifests = [
    createTestManifest({
      id: 'file-manager',
      actions: [
        createTestAction({ name: 'read_file' }),
        createTestAction({ name: 'write_file' }),
      ],
    }),
    createTestManifest({
      id: 'web-fetch',
      actions: [
        createTestAction({ name: 'fetch_url', description: 'Fetch a URL' }),
      ],
    }),
  ];

  beforeEach(() => {
    adapter = new MCPServerAdapter({ manifests });
  });

  describe('listTools', () => {
    it('should list all tools from all manifests', () => {
      const tools = adapter.listTools();

      expect(tools).toHaveLength(3);
      const names = tools.map((t) => t.name);
      expect(names).toContain('file-manager.read_file');
      expect(names).toContain('file-manager.write_file');
      expect(names).toContain('web-fetch.fetch_url');
    });

    it('should return empty array when no manifests provided', () => {
      const emptyAdapter = new MCPServerAdapter({ manifests: [] });
      expect(emptyAdapter.listTools()).toHaveLength(0);
    });
  });

  describe('resolveToolName', () => {
    it('should resolve a valid tool name to gear ID and action', () => {
      const result = adapter.resolveToolName('file-manager.read_file');

      expect(result).not.toBeNull();
      expect(result!.gearId).toBe('file-manager');
      expect(result!.action).toBe('read_file');
    });

    it('should return null for names without a separator', () => {
      expect(adapter.resolveToolName('noperiod')).toBeNull();
    });

    it('should return null for names starting with separator', () => {
      expect(adapter.resolveToolName('.action')).toBeNull();
    });

    it('should return null for names ending with separator', () => {
      expect(adapter.resolveToolName('gear.')).toBeNull();
    });

    it('should handle names with multiple periods', () => {
      const result = adapter.resolveToolName('my-gear.nested.action');

      expect(result).not.toBeNull();
      expect(result!.gearId).toBe('my-gear');
      expect(result!.action).toBe('nested.action');
    });
  });

  describe('callTool', () => {
    it('should return error when no executor is set', async () => {
      const result = await adapter.callTool('file-manager.read_file', {});

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('No executor configured');
    });

    it('should return error for unknown tool', async () => {
      adapter.setExecutor(vi.fn());
      const result = await adapter.callTool('unknown.tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Unknown tool');
    });

    it('should execute the tool via the executor', async () => {
      const executor = vi.fn().mockResolvedValue({ content: 'file data' });
      adapter.setExecutor(executor);

      const result = await adapter.callTool('file-manager.read_file', {
        path: '/test.txt',
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        content: 'file data',
      });
      expect(executor).toHaveBeenCalledWith('file-manager', 'read_file', {
        path: '/test.txt',
      });
    });

    it('should handle executor errors gracefully', async () => {
      const executor = vi.fn().mockRejectedValue(new Error('disk full'));
      adapter.setExecutor(executor);

      const result = await adapter.callTool('file-manager.read_file', {});

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('disk full');
    });
  });

  describe('handleRequest', () => {
    it('should handle initialize request', async () => {
      const response = await adapter.handleRequest(
        buildRequest({ method: 'initialize' }),
      );

      expect(response.error).toBeUndefined();
      const result = response.result as Record<string, unknown>;
      expect(result['protocolVersion']).toBe('2024-11-05');
      expect(result['serverInfo']).toEqual({
        name: 'meridian-gear',
        version: '0.4.0',
      });
    });

    it('should handle tools/list request', async () => {
      const response = await adapter.handleRequest(
        buildRequest({ method: 'tools/list' }),
      );

      expect(response.error).toBeUndefined();
      const result = response.result as { tools: MCPToolDefinition[] };
      expect(result.tools).toHaveLength(3);
    });

    it('should handle tools/call request', async () => {
      const executor = vi.fn().mockResolvedValue({ ok: true });
      adapter.setExecutor(executor);

      const response = await adapter.handleRequest(
        buildRequest({
          method: 'tools/call',
          params: {
            name: 'file-manager.read_file',
            arguments: { path: '/test.txt' },
          },
        }),
      );

      expect(response.error).toBeUndefined();
      expect(executor).toHaveBeenCalledWith('file-manager', 'read_file', {
        path: '/test.txt',
      });
    });

    it('should return error for tools/call without params', async () => {
      const response = await adapter.handleRequest(
        buildRequest({ method: 'tools/call', params: undefined }),
      );

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    it('should return error for tools/call without name', async () => {
      const response = await adapter.handleRequest(
        buildRequest({ method: 'tools/call', params: {} }),
      );

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    it('should return error for unknown method', async () => {
      const response = await adapter.handleRequest(
        buildRequest({ method: 'unknown/method' }),
      );

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
    });

    it('should return error for invalid JSON-RPC version', async () => {
      const response = await adapter.handleRequest({
        jsonrpc: '1.0' as '2.0',
        id: 1,
        method: 'tools/list',
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
    });

    it('should return error for empty method', async () => {
      const response = await adapter.handleRequest(
        buildRequest({ method: '' }),
      );

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
    });

    it('should preserve request ID in response', async () => {
      const response = await adapter.handleRequest(
        buildRequest({ id: 'my-request-42', method: 'tools/list' }),
      );

      expect(response.id).toBe('my-request-42');
      expect(response.jsonrpc).toBe('2.0');
    });

    it('should handle tools/call with default empty arguments', async () => {
      const executor = vi.fn().mockResolvedValue({});
      adapter.setExecutor(executor);

      await adapter.handleRequest(
        buildRequest({
          method: 'tools/call',
          params: { name: 'file-manager.read_file' },
        }),
      );

      expect(executor).toHaveBeenCalledWith('file-manager', 'read_file', {});
    });
  });

  describe('duplicate tool handling', () => {
    it('should handle duplicate tool names by overwriting', () => {
      const duplicateManifests = [
        createTestManifest({
          id: 'gear-a',
          actions: [createTestAction({ name: 'action' })],
        }),
        createTestManifest({
          id: 'gear-a',
          actions: [
            createTestAction({
              name: 'action',
              description: 'Override',
            }),
          ],
        }),
      ];

      const dupeAdapter = new MCPServerAdapter({
        manifests: duplicateManifests,
      });

      const tools = dupeAdapter.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.description).toBe('Override');
    });
  });
});
