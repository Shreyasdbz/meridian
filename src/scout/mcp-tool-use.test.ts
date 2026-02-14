/* eslint-disable @typescript-eslint/no-non-null-assertion */
// @meridian/scout — MCP Tool Use tests (Phase 11.2)

import { describe, it, expect } from 'vitest';

import type { GearManifest, MCPToolDefinition, ToolDefinition } from '@meridian/shared';

import {
  gearToMCPTools,
  mcpToProviderTools,
  supportsNativeMCP,
} from './mcp-tool-use.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTestManifest(overrides?: Partial<GearManifest>): GearManifest {
  return {
    id: 'test-gear',
    name: 'Test Gear',
    version: '1.0.0',
    description: 'A test Gear',
    author: 'test',
    license: 'MIT',
    origin: 'builtin',
    checksum: 'abc123',
    actions: [
      {
        name: 'do_something',
        description: 'Does something',
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
// Tests: gearToMCPTools
// ---------------------------------------------------------------------------

describe('gearToMCPTools', () => {
  it('should convert a single manifest with one action', () => {
    const manifests = [createTestManifest()];
    const tools = gearToMCPTools(manifests);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('test-gear.do_something');
    expect(tools[0]!.description).toBe('Does something');
    expect(tools[0]!.inputSchema).toEqual({
      type: 'object',
      properties: { input: { type: 'string' } },
    });
  });

  it('should convert multiple manifests with multiple actions', () => {
    const manifests = [
      createTestManifest({
        id: 'gear-a',
        actions: [
          {
            name: 'action_one',
            description: 'First',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel: 'low',
          },
          {
            name: 'action_two',
            description: 'Second',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel: 'medium',
          },
        ],
      }),
      createTestManifest({
        id: 'gear-b',
        actions: [
          {
            name: 'action_three',
            description: 'Third',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel: 'high',
          },
        ],
      }),
    ];

    const tools = gearToMCPTools(manifests);

    expect(tools).toHaveLength(3);
    expect(tools[0]!.name).toBe('gear-a.action_one');
    expect(tools[1]!.name).toBe('gear-a.action_two');
    expect(tools[2]!.name).toBe('gear-b.action_three');
  });

  it('should return empty array for empty manifests list', () => {
    const tools = gearToMCPTools([]);
    expect(tools).toHaveLength(0);
  });

  it('should return empty array for manifest with no actions', () => {
    const manifests = [createTestManifest({ actions: [] })];
    const tools = gearToMCPTools(manifests);
    expect(tools).toHaveLength(0);
  });

  it('should produce unique names across different gears', () => {
    const manifests = [
      createTestManifest({
        id: 'gear-a',
        actions: [
          {
            name: 'action',
            description: 'A',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel: 'low',
          },
        ],
      }),
      createTestManifest({
        id: 'gear-b',
        actions: [
          {
            name: 'action',
            description: 'B',
            parameters: { type: 'object' },
            returns: { type: 'object' },
            riskLevel: 'low',
          },
        ],
      }),
    ];

    const tools = gearToMCPTools(manifests);
    const names = tools.map((t) => t.name);

    expect(names[0]).toBe('gear-a.action');
    expect(names[1]).toBe('gear-b.action');
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// Tests: mcpToProviderTools
// ---------------------------------------------------------------------------

describe('mcpToProviderTools', () => {
  it('should convert MCP tool definitions to provider tools', () => {
    const mcpTools: MCPToolDefinition[] = [
      {
        name: 'gear-a.read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ];

    const providerTools = mcpToProviderTools(mcpTools);

    expect(providerTools).toHaveLength(1);
    expect(providerTools[0]!.name).toBe('gear-a.read_file');
    expect(providerTools[0]!.description).toBe('Read a file');
    expect(providerTools[0]!.inputSchema).toEqual(mcpTools[0]!.inputSchema);
  });

  it('should convert multiple tools', () => {
    const mcpTools: MCPToolDefinition[] = [
      {
        name: 'tool-a',
        description: 'A',
        inputSchema: { type: 'object' },
      },
      {
        name: 'tool-b',
        description: 'B',
        inputSchema: { type: 'object' },
      },
    ];

    const providerTools = mcpToProviderTools(mcpTools);

    expect(providerTools).toHaveLength(2);
  });

  it('should return empty array for empty input', () => {
    expect(mcpToProviderTools([])).toHaveLength(0);
  });

  it('should produce valid ToolDefinition objects', () => {
    const mcpTools: MCPToolDefinition[] = [
      {
        name: 'my-tool',
        description: 'My tool description',
        inputSchema: {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x'],
        },
      },
    ];

    const result = mcpToProviderTools(mcpTools);
    const tool: ToolDefinition = result[0]!;

    expect(tool.name).toEqual(expect.any(String));
    expect(tool.description).toEqual(expect.any(String));
    expect(tool.inputSchema).toEqual(expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// Tests: supportsNativeMCP
// ---------------------------------------------------------------------------

describe('supportsNativeMCP', () => {
  it('should return true for Anthropic', () => {
    expect(supportsNativeMCP('anthropic')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(supportsNativeMCP('Anthropic')).toBe(true);
    expect(supportsNativeMCP('ANTHROPIC')).toBe(true);
  });

  it('should return false for OpenAI', () => {
    expect(supportsNativeMCP('openai')).toBe(false);
  });

  it('should return false for Google', () => {
    expect(supportsNativeMCP('google')).toBe(false);
  });

  it('should return false for Ollama', () => {
    expect(supportsNativeMCP('ollama')).toBe(false);
  });

  it('should return false for OpenRouter', () => {
    expect(supportsNativeMCP('openrouter')).toBe(false);
  });

  it('should return false for unknown providers', () => {
    expect(supportsNativeMCP('unknown-provider')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(supportsNativeMCP('')).toBe(false);
  });
});
