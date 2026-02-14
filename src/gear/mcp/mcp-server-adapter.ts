// @meridian/gear — MCP Server Adapter (Section 9.4)
// Exposes Gear actions as MCP-compatible tools via JSON-RPC protocol.

import type {
  GearManifest,
  GearAction,
  MCPToolDefinition,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logger interface for the MCP server adapter.
 */
export interface MCPServerAdapterLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Configuration for creating an MCPServerAdapter instance.
 */
export interface MCPServerAdapterConfig {
  manifests: GearManifest[];
  logger?: MCPServerAdapterLogger;
}

/**
 * MCP JSON-RPC 2.0 request.
 */
export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * MCP JSON-RPC 2.0 response.
 */
export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: MCPError;
}

/**
 * MCP JSON-RPC error object.
 */
export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Result from an MCP tool call.
 */
export interface MCPToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Callback to execute a Gear action. Provided by the host.
 */
export type MCPToolExecutor = (
  gearId: string,
  action: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// MCP JSON-RPC error codes (per spec)
// ---------------------------------------------------------------------------

const MCP_INVALID_REQUEST = -32600;
const MCP_METHOD_NOT_FOUND = -32601;
const MCP_INVALID_PARAMS = -32602;
const MCP_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Separator used in MCP tool names to combine gear ID and action name.
 * Format: "gear-id.action_name"
 */
const TOOL_NAME_SEPARATOR = '.';

/**
 * Convert a single GearAction to an MCP tool definition.
 *
 * The MCP tool name is formed as "gearId.actionName" to ensure uniqueness
 * across multiple Gear manifests.
 */
export function gearActionToMCPTool(
  gearId: string,
  action: GearAction,
): MCPToolDefinition {
  return {
    name: `${gearId}${TOOL_NAME_SEPARATOR}${action.name}`,
    description: action.description,
    inputSchema: action.parameters,
  };
}

/**
 * Convert all actions from a GearManifest to MCP tool definitions.
 */
export function manifestToMCPTools(manifest: GearManifest): MCPToolDefinition[] {
  return manifest.actions.map((action) =>
    gearActionToMCPTool(manifest.id, action),
  );
}

// ---------------------------------------------------------------------------
// MCPServerAdapter
// ---------------------------------------------------------------------------

/**
 * MCP Server Adapter — exposes Gear actions as MCP-compatible tools.
 *
 * Implements the MCP JSON-RPC protocol for:
 * - `tools/list` — returns all registered tools
 * - `tools/call` — executes a tool by name
 * - `initialize` — returns server capabilities
 *
 * Usage:
 * ```ts
 * const adapter = new MCPServerAdapter({
 *   manifests: [fileManagerManifest, webFetchManifest],
 * });
 * adapter.setExecutor(async (gearId, action, args) => {
 *   return gearHost.execute(gearId, action, args);
 * });
 * const response = await adapter.handleRequest(request);
 * ```
 */
export class MCPServerAdapter {
  private readonly tools: Map<string, MCPToolDefinition>;
  private readonly toolToGear: Map<string, { gearId: string; action: string }>;
  private readonly logger: MCPServerAdapterLogger;
  private executor: MCPToolExecutor | null = null;

  constructor(config: MCPServerAdapterConfig) {
    this.tools = new Map();
    this.toolToGear = new Map();
    this.logger = config.logger ?? {
      info: () => {},
      warn: () => {},
      debug: () => {},
    };

    // Index all tools from provided manifests
    for (const manifest of config.manifests) {
      const mcpTools = manifestToMCPTools(manifest);
      for (const tool of mcpTools) {
        if (this.tools.has(tool.name)) {
          this.logger.warn('Duplicate MCP tool name, overwriting', {
            name: tool.name,
          });
        }
        this.tools.set(tool.name, tool);
        const resolved = this.resolveToolName(tool.name);
        if (resolved) {
          this.toolToGear.set(tool.name, resolved);
        }
      }
    }

    this.logger.info('MCP server adapter initialized', {
      toolCount: this.tools.size,
    });
  }

  /**
   * Set the executor callback that handles actual Gear action execution.
   * Must be set before calling `callTool()`.
   */
  setExecutor(executor: MCPToolExecutor): void {
    this.executor = executor;
  }

  /**
   * Handle an incoming MCP JSON-RPC request and return a response.
   */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    // Validate basic JSON-RPC structure (runtime check for external input)
    if ((request.jsonrpc as string) !== '2.0') {
      return this.buildError(
        request.id,
        MCP_INVALID_REQUEST,
        'Invalid JSON-RPC version, expected "2.0"',
      );
    }

    if (typeof request.method !== 'string' || request.method.length === 0) {
      return this.buildError(
        request.id,
        MCP_INVALID_REQUEST,
        'Missing or empty method',
      );
    }

    this.logger.debug('Handling MCP request', {
      method: request.method,
      id: request.id,
    });

    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      case 'tools/list':
        return this.handleToolsList(request);
      case 'tools/call':
        return this.handleToolsCall(request);
      default:
        return this.buildError(
          request.id,
          MCP_METHOD_NOT_FOUND,
          `Unknown method: "${request.method}"`,
        );
    }
  }

  /**
   * List all available MCP tools.
   */
  listTools(): MCPToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Execute a tool by its MCP name.
   * Requires an executor to be set via `setExecutor()`.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    if (!this.executor) {
      return {
        content: [{ type: 'text', text: 'No executor configured' }],
        isError: true,
      };
    }

    const resolved = this.toolToGear.get(name);
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `Unknown tool: "${name}"` }],
        isError: true,
      };
    }

    try {
      const result = await this.executor(resolved.gearId, resolved.action, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('MCP tool call failed', {
        tool: name,
        error: message,
      });
      return {
        content: [{ type: 'text', text: `Tool execution failed: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Resolve an MCP tool name back to the Gear ID and action name.
   * Returns null if the name does not match the expected format.
   */
  resolveToolName(
    name: string,
  ): { gearId: string; action: string } | null {
    const separatorIndex = name.indexOf(TOOL_NAME_SEPARATOR);
    if (separatorIndex <= 0 || separatorIndex >= name.length - 1) {
      return null;
    }

    return {
      gearId: name.slice(0, separatorIndex),
      action: name.slice(separatorIndex + 1),
    };
  }

  // -------------------------------------------------------------------------
  // Protocol handlers
  // -------------------------------------------------------------------------

  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'meridian-gear',
          version: '0.4.0',
        },
      },
    };
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: this.listTools(),
      },
    };
  }

  private async handleToolsCall(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params;
    if (!params) {
      return this.buildError(
        request.id,
        MCP_INVALID_PARAMS,
        'Missing params for tools/call',
      );
    }

    const name = params['name'];
    if (typeof name !== 'string' || name.length === 0) {
      return this.buildError(
        request.id,
        MCP_INVALID_PARAMS,
        'Missing or invalid "name" param',
      );
    }

    const rawArgs: unknown = params['arguments'];
    const args = (typeof rawArgs === 'object' && rawArgs !== null)
      ? rawArgs as Record<string, unknown>
      : {};

    try {
      const result = await this.callTool(name, args);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.buildError(
        request.id,
        MCP_INTERNAL_ERROR,
        `Tool call failed: ${message}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildError(
    id: string | number,
    code: number,
    message: string,
  ): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
  }
}
