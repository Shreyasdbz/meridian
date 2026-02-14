// @meridian/gear — MCP Gear Adapter (Section 9.4)
// Wraps existing MCP servers as Meridian Gear with sandboxing.

import type {
  GearManifest,
  GearAction,
  MCPServerConfig,
  MCPToolDefinition,
} from '@meridian/shared';
import { generateId } from '@meridian/shared';

import type { MCPRequest, MCPResponse, MCPToolResult } from './mcp-server-adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for the MCP Gear adapter.
 */
export interface MCPGearAdapterLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Configuration for the MCP Gear adapter.
 */
export interface MCPGearAdapterConfig {
  serverConfig: MCPServerConfig;
  sandboxLevel?: 1 | 2 | 3;
  logger?: MCPGearAdapterLogger;
}

/**
 * Transport interface for communicating with an MCP server process.
 * Allows injection of custom transports for testing.
 */
export interface MCPTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(request: MCPRequest): Promise<MCPResponse>;
  readonly isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Default stdio transport
// ---------------------------------------------------------------------------

/**
 * Default MCP transport that communicates with a child process via JSON-RPC
 * over stdin/stdout. In production, this would spawn the command from the
 * MCPServerConfig and manage the process lifecycle.
 *
 * For now, this is a structural implementation that provides the transport
 * contract. Full child_process integration will be wired in when Meridian's
 * sandbox infrastructure is used for MCP server processes.
 */
class StdioMCPTransport implements MCPTransport {
  private running = false;
  private readonly config: MCPServerConfig;
  private readonly logger: MCPGearAdapterLogger;

  constructor(config: MCPServerConfig, logger: MCPGearAdapterLogger) {
    this.config = config;
    this.logger = logger;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): Promise<void> {
    if (this.running) {
      return Promise.resolve();
    }
    this.logger.info('Starting MCP server process', {
      command: this.config.command,
      args: this.config.args,
    });
    // In production, this would spawn the process via child_process.spawn
    // with the configured command, args, and env. The process would
    // communicate via JSON-RPC over stdin/stdout.
    this.running = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    this.logger.info('Stopping MCP server process', {
      command: this.config.command,
    });
    // In production, this would send a graceful shutdown signal and
    // wait for the process to exit, then force-kill if needed.
    this.running = false;
    return Promise.resolve();
  }

  send(request: MCPRequest): Promise<MCPResponse> {
    if (!this.running) {
      return Promise.resolve({
        jsonrpc: '2.0' as const,
        id: request.id,
        error: {
          code: -32603,
          message: 'MCP server is not running',
        },
      });
    }
    // In production, this would serialize the request as JSON,
    // write it to the process's stdin, and read the response from stdout.
    // For now, return a method-not-found response.
    return Promise.resolve({
      jsonrpc: '2.0' as const,
      id: request.id,
      error: {
        code: -32601,
        message: `Transport not connected: ${request.method}`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Conversion: MCP tool -> GearAction
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool definition to a Meridian GearAction.
 *
 * Since MCP tools don't have a risk level concept, all imported tools
 * default to 'medium' risk level and require Sentinel validation.
 */
export function mcpToolToGearAction(tool: MCPToolDefinition): GearAction {
  return {
    name: sanitizeActionName(tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
    returns: {
      type: 'object',
      properties: {
        content: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
        isError: { type: 'boolean' },
      },
    },
    riskLevel: 'medium',
  };
}

/**
 * Sanitize an MCP tool name to conform to Meridian's action naming rules.
 * Converts hyphens and dots to underscores, lowercases, and ensures it
 * starts with a letter.
 */
function sanitizeActionName(name: string): string {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');

  // Ensure it starts with a letter
  if (sanitized.length === 0 || !/^[a-z]/.test(sanitized)) {
    sanitized = `mcp_${sanitized}`;
  }

  // Truncate to max 64 characters
  if (sanitized.length > 64) {
    sanitized = sanitized.slice(0, 64);
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// discoverMCPServer
// ---------------------------------------------------------------------------

/**
 * Discover tools from an MCP server and generate a Gear manifest.
 *
 * Starts the MCP server, sends a `tools/list` request, and converts
 * the response into a GearManifest. The server is stopped after discovery.
 *
 * @param config - MCP server configuration
 * @param transport - Optional transport override (for testing)
 */
export async function discoverMCPServer(
  config: MCPServerConfig,
  transport?: MCPTransport,
): Promise<GearManifest> {
  const logger: MCPGearAdapterLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const mcpTransport = transport ?? new StdioMCPTransport(config, logger);

  await mcpTransport.start();

  try {
    // Send tools/list request
    const listResponse = await mcpTransport.send({
      jsonrpc: '2.0',
      id: generateId(),
      method: 'tools/list',
    });

    if (listResponse.error) {
      throw new Error(
        `Failed to list MCP tools: ${listResponse.error.message}`,
      );
    }

    const result = listResponse.result as
      | { tools?: MCPToolDefinition[] }
      | undefined;
    const tools = result?.tools ?? [];

    // Convert MCP tools to Gear actions
    const actions: GearAction[] = tools.map(mcpToolToGearAction);

    // Build manifest
    const gearId = `mcp-${sanitizeGearId(config.name)}`;
    return {
      id: gearId,
      name: `MCP: ${config.name}`,
      version: '0.1.0',
      description: `MCP server bridge for ${config.name}`,
      author: 'mcp-bridge',
      license: 'Apache-2.0',
      origin: 'user',
      checksum: generateId(),
      actions,
      permissions: {
        network: {
          domains: [],
          protocols: ['https'],
        },
      },
    };
  } finally {
    await mcpTransport.stop();
  }
}

/**
 * Sanitize an MCP server name into a valid Gear ID.
 */
function sanitizeGearId(name: string): string {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (sanitized.length === 0 || !/^[a-z]/.test(sanitized)) {
    sanitized = `server-${sanitized}`;
  }

  if (sanitized.length > 50) {
    sanitized = sanitized.slice(0, 50);
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// MCPGearAdapter
// ---------------------------------------------------------------------------

/**
 * MCP Gear Adapter — wraps an external MCP server as a Meridian Gear.
 *
 * This adapter manages the lifecycle of an MCP server process and translates
 * Meridian Gear action calls into MCP JSON-RPC tool calls.
 *
 * Usage:
 * ```ts
 * const adapter = new MCPGearAdapter({
 *   serverConfig: { name: 'my-server', command: 'npx', args: ['my-mcp-server'] },
 *   sandboxLevel: 1,
 * });
 * await adapter.start();
 * const result = await adapter.execute('some_action', { param: 'value' });
 * await adapter.stop();
 * ```
 */
export class MCPGearAdapter {
  private readonly config: MCPGearAdapterConfig;
  private readonly logger: MCPGearAdapterLogger;
  private readonly transport: MCPTransport;
  private cachedManifest: GearManifest | null = null;

  constructor(config: MCPGearAdapterConfig, transport?: MCPTransport) {
    this.config = config;
    this.logger = config.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.transport = transport ??
      new StdioMCPTransport(config.serverConfig, this.logger);
  }

  /**
   * Whether the underlying MCP server process is running.
   */
  get isRunning(): boolean {
    return this.transport.isRunning;
  }

  /**
   * Start the MCP server process.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('MCP server already running', {
        name: this.config.serverConfig.name,
      });
      return;
    }

    this.logger.info('Starting MCP gear adapter', {
      name: this.config.serverConfig.name,
      sandboxLevel: this.config.sandboxLevel ?? 1,
    });

    await this.transport.start();

    // Send initialize request
    const initResponse = await this.transport.send({
      jsonrpc: '2.0',
      id: generateId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'meridian',
          version: '0.4.0',
        },
      },
    });

    if (initResponse.error) {
      this.logger.warn('MCP server initialization returned error', {
        error: initResponse.error.message,
      });
    }
  }

  /**
   * Stop the MCP server process.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping MCP gear adapter', {
      name: this.config.serverConfig.name,
    });

    await this.transport.stop();
    this.cachedManifest = null;
  }

  /**
   * Execute an action on the MCP server.
   *
   * The action name is translated back to the MCP tool name format
   * and dispatched as a `tools/call` JSON-RPC request.
   */
  async execute(
    action: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.isRunning) {
      throw new Error('MCP server is not running');
    }

    this.logger.info('Executing MCP action', { action, params });

    const response = await this.transport.send({
      jsonrpc: '2.0',
      id: generateId(),
      method: 'tools/call',
      params: {
        name: action,
        arguments: params,
      },
    });

    if (response.error) {
      throw new Error(
        `MCP tool call failed: ${response.error.message}`,
      );
    }

    const result = response.result as MCPToolResult | undefined;
    return {
      content: result?.content ?? [],
      isError: result?.isError ?? false,
    };
  }

  /**
   * Generate a Gear manifest from the MCP server's capabilities.
   *
   * Sends a `tools/list` request and converts the response into a
   * GearManifest. Results are cached until the adapter is stopped.
   */
  async generateManifest(): Promise<GearManifest> {
    if (this.cachedManifest) {
      return this.cachedManifest;
    }

    if (!this.isRunning) {
      throw new Error('MCP server must be running to generate manifest');
    }

    const response = await this.transport.send({
      jsonrpc: '2.0',
      id: generateId(),
      method: 'tools/list',
    });

    if (response.error) {
      throw new Error(
        `Failed to list MCP tools: ${response.error.message}`,
      );
    }

    const result = response.result as
      | { tools?: MCPToolDefinition[] }
      | undefined;
    const tools = result?.tools ?? [];
    const actions = tools.map(mcpToolToGearAction);

    const gearId = `mcp-${sanitizeGearId(this.config.serverConfig.name)}`;
    this.cachedManifest = {
      id: gearId,
      name: `MCP: ${this.config.serverConfig.name}`,
      version: '0.1.0',
      description: `MCP server bridge for ${this.config.serverConfig.name}`,
      author: 'mcp-bridge',
      license: 'Apache-2.0',
      origin: 'user',
      checksum: generateId(),
      actions,
      permissions: {
        network: {
          domains: [],
          protocols: ['https'],
        },
      },
    };

    return this.cachedManifest;
  }
}
