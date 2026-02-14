/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
// @meridian/gear — MCP Gear Adapter tests (Phase 11.2)

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { MCPServerConfig, MCPToolDefinition } from '@meridian/shared';

import {
  mcpToolToGearAction,
  discoverMCPServer,
  MCPGearAdapter,
} from './mcp-gear-adapter.js';
import type { MCPTransport } from './mcp-gear-adapter.js';
import type { MCPRequest, MCPResponse } from './mcp-server-adapter.js';

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

function createMockTransport(
  toolsResponse?: MCPToolDefinition[],
): MCPTransport {
  let running = false;
  const tools = toolsResponse ?? [
    {
      name: 'get-weather',
      description: 'Get the current weather',
      inputSchema: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    },
    {
      name: 'search-web',
      description: 'Search the web',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    },
  ];

  return {
    get isRunning(): boolean {
      return running;
    },

    start: vi.fn(async () => {
      running = true;
    }),

    stop: vi.fn(async () => {
      running = false;
    }),

    send: vi.fn(async (request: MCPRequest): Promise<MCPResponse> => {
      if (!running) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: 'Not running' },
        };
      }

      switch (request.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'test-server', version: '1.0.0' },
            },
          };

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: { tools },
          };

        case 'tools/call': {
          const params = request.params ?? {};
          const name = params['name'] as string;
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ tool: name, executed: true }),
                },
              ],
            },
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: `Unknown method: ${request.method}` },
          };
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// Test server config
// ---------------------------------------------------------------------------

const testServerConfig: MCPServerConfig = {
  name: 'test-server',
  command: 'npx',
  args: ['test-mcp-server'],
  env: { TEST: 'true' },
};

// ---------------------------------------------------------------------------
// Tests: mcpToolToGearAction
// ---------------------------------------------------------------------------

describe('mcpToolToGearAction', () => {
  it('should convert an MCP tool to a GearAction', () => {
    const tool: MCPToolDefinition = {
      name: 'fetch-url',
      description: 'Fetch a URL and return content',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
    };

    const action = mcpToolToGearAction(tool);

    expect(action.name).toBe('fetch_url');
    expect(action.description).toBe('Fetch a URL and return content');
    expect(action.parameters).toEqual(tool.inputSchema);
    expect(action.riskLevel).toBe('medium');
  });

  it('should sanitize tool names with special characters', () => {
    const tool: MCPToolDefinition = {
      name: 'my.special-tool!v2',
      description: 'Test',
      inputSchema: { type: 'object' },
    };

    const action = mcpToolToGearAction(tool);

    expect(action.name).toBe('my_special_tool_v2');
  });

  it('should prefix names that start with numbers', () => {
    const tool: MCPToolDefinition = {
      name: '123-tool',
      description: 'Test',
      inputSchema: { type: 'object' },
    };

    const action = mcpToolToGearAction(tool);

    expect(action.name).toMatch(/^[a-z]/);
    expect(action.name).toBe('mcp_123_tool');
  });

  it('should handle empty tool names', () => {
    const tool: MCPToolDefinition = {
      name: '',
      description: 'Test',
      inputSchema: { type: 'object' },
    };

    const action = mcpToolToGearAction(tool);

    expect(action.name).toMatch(/^mcp_/);
  });

  it('should set default risk level to medium', () => {
    const tool: MCPToolDefinition = {
      name: 'safe-tool',
      description: 'A safe tool',
      inputSchema: { type: 'object' },
    };

    const action = mcpToolToGearAction(tool);

    expect(action.riskLevel).toBe('medium');
  });

  it('should include a returns schema', () => {
    const tool: MCPToolDefinition = {
      name: 'test',
      description: 'Test',
      inputSchema: { type: 'object' },
    };

    const action = mcpToolToGearAction(tool);

    expect(action.returns).toBeDefined();
    expect(action.returns['type']).toBe('object');
  });

  it('should truncate long tool names to 64 characters', () => {
    const longName = 'a'.repeat(100);
    const tool: MCPToolDefinition = {
      name: longName,
      description: 'Test',
      inputSchema: { type: 'object' },
    };

    const action = mcpToolToGearAction(tool);

    expect(action.name.length).toBeLessThanOrEqual(64);
  });
});

// ---------------------------------------------------------------------------
// Tests: discoverMCPServer
// ---------------------------------------------------------------------------

describe('discoverMCPServer', () => {
  it('should discover tools from an MCP server', async () => {
    const transport = createMockTransport();
    const manifest = await discoverMCPServer(testServerConfig, transport);

    expect(manifest.id).toMatch(/^mcp-/);
    expect(manifest.name).toContain(testServerConfig.name);
    expect(manifest.actions).toHaveLength(2);
    expect(manifest.origin).toBe('user');
    expect(manifest.license).toBe('Apache-2.0');
  });

  it('should sanitize the Gear ID from server name', async () => {
    const transport = createMockTransport();
    const config: MCPServerConfig = {
      ...testServerConfig,
      name: 'My Special Server!',
    };

    const manifest = await discoverMCPServer(config, transport);

    expect(manifest.id).toBe('mcp-my-special-server');
  });

  it('should stop the transport after discovery', async () => {
    const transport = createMockTransport();
    await discoverMCPServer(testServerConfig, transport);

    expect(transport.isRunning).toBe(false);
    expect(transport.stop).toHaveBeenCalled();
  });

  it('should handle servers with no tools', async () => {
    const transport = createMockTransport([]);
    const manifest = await discoverMCPServer(testServerConfig, transport);

    expect(manifest.actions).toHaveLength(0);
  });

  it('should stop transport even on error', async () => {
    const transport = createMockTransport();
    (transport.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      jsonrpc: '2.0',
      id: 'test',
      error: { code: -1, message: 'Server error' },
    });

    await expect(
      discoverMCPServer(testServerConfig, transport),
    ).rejects.toThrow('Failed to list MCP tools');

    expect(transport.stop).toHaveBeenCalled();
  });

  it('should convert discovered tool names to valid action names', async () => {
    const transport = createMockTransport([
      {
        name: 'get-weather',
        description: 'Get weather',
        inputSchema: { type: 'object' },
      },
    ]);

    const manifest = await discoverMCPServer(testServerConfig, transport);

    expect(manifest.actions[0]!.name).toBe('get_weather');
  });
});

// ---------------------------------------------------------------------------
// Tests: MCPGearAdapter
// ---------------------------------------------------------------------------

describe('MCPGearAdapter', () => {
  let transport: MCPTransport;
  let adapter: MCPGearAdapter;

  beforeEach(() => {
    transport = createMockTransport();
    adapter = new MCPGearAdapter(
      { serverConfig: testServerConfig },
      transport,
    );
  });

  describe('lifecycle', () => {
    it('should report not running initially', () => {
      expect(adapter.isRunning).toBe(false);
    });

    it('should start the transport', async () => {
      await adapter.start();

      expect(adapter.isRunning).toBe(true);
      expect(transport.start).toHaveBeenCalled();
    });

    it('should send initialize on start', async () => {
      await adapter.start();

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'initialize' }),
      );
    });

    it('should not start twice', async () => {
      await adapter.start();
      await adapter.start();

      expect(transport.start).toHaveBeenCalledTimes(1);
    });

    it('should stop the transport', async () => {
      await adapter.start();
      await adapter.stop();

      expect(adapter.isRunning).toBe(false);
      expect(transport.stop).toHaveBeenCalled();
    });

    it('should be safe to stop when not running', async () => {
      await adapter.stop();

      expect(transport.stop).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('should throw when not running', async () => {
      await expect(
        adapter.execute('test_action', {}),
      ).rejects.toThrow('MCP server is not running');
    });

    it('should send tools/call request', async () => {
      await adapter.start();

      const result = await adapter.execute('get_weather', {
        location: 'London',
      });

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'tools/call',
          params: {
            name: 'get_weather',
            arguments: { location: 'London' },
          },
        }),
      );
      expect(result['content']).toBeDefined();
    });

    it('should throw on MCP error response', async () => {
      await adapter.start();

      // Override send to return error for tools/call
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 'test',
        error: { code: -1, message: 'Tool not found' },
      });

      await expect(
        adapter.execute('unknown_tool', {}),
      ).rejects.toThrow('MCP tool call failed: Tool not found');
    });
  });

  describe('generateManifest', () => {
    it('should throw when not running', async () => {
      await expect(adapter.generateManifest()).rejects.toThrow(
        'MCP server must be running',
      );
    });

    it('should generate manifest from discovered tools', async () => {
      await adapter.start();
      const manifest = await adapter.generateManifest();

      expect(manifest.id).toMatch(/^mcp-/);
      expect(manifest.actions).toHaveLength(2);
      expect(manifest.origin).toBe('user');
    });

    it('should cache the manifest', async () => {
      await adapter.start();

      const manifest1 = await adapter.generateManifest();
      const manifest2 = await adapter.generateManifest();

      expect(manifest1).toBe(manifest2);
      // tools/list should only be called once (second call uses cache)
      const toolsListCalls = (transport.send as ReturnType<typeof vi.fn>)
        .mock.calls.filter(
          (call) => (call[0] as MCPRequest).method === 'tools/list',
        );
      expect(toolsListCalls).toHaveLength(1);
    });

    it('should clear cache on stop', async () => {
      await adapter.start();
      await adapter.generateManifest();
      await adapter.stop();
      await adapter.start();

      // Should call tools/list again after stop/start
      const manifest = await adapter.generateManifest();
      expect(manifest.actions).toHaveLength(2);

      const toolsListCalls = (transport.send as ReturnType<typeof vi.fn>)
        .mock.calls.filter(
          (call) => (call[0] as MCPRequest).method === 'tools/list',
        );
      expect(toolsListCalls).toHaveLength(2);
    });

    it('should handle error from tools/list', async () => {
      await adapter.start();

      // Override for the tools/list call after initialize
      (transport.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 'test',
        error: { code: -1, message: 'Server error' },
      });

      await expect(adapter.generateManifest()).rejects.toThrow(
        'Failed to list MCP tools',
      );
    });
  });

  describe('with custom logger', () => {
    it('should log lifecycle events', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const loggedAdapter = new MCPGearAdapter(
        { serverConfig: testServerConfig, logger },
        transport,
      );

      await loggedAdapter.start();
      expect(logger.info).toHaveBeenCalledWith(
        'Starting MCP gear adapter',
        expect.objectContaining({ name: 'test-server' }),
      );

      await loggedAdapter.stop();
      expect(logger.info).toHaveBeenCalledWith(
        'Stopping MCP gear adapter',
        expect.objectContaining({ name: 'test-server' }),
      );
    });
  });

  describe('with sandbox level', () => {
    it('should accept sandbox level configuration', () => {
      const adapterL3 = new MCPGearAdapter(
        { serverConfig: testServerConfig, sandboxLevel: 3 },
        transport,
      );

      // Adapter is constructed without error
      expect(adapterL3.isRunning).toBe(false);
    });
  });
});
