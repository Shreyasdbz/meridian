// @meridian/gear — MCP compatibility layer (Section 9.4)

// MCP Server Adapter — exposes Gear as MCP tools
export {
  gearActionToMCPTool,
  manifestToMCPTools,
  MCPServerAdapter,
} from './mcp-server-adapter.js';
export type {
  MCPServerAdapterConfig,
  MCPServerAdapterLogger,
  MCPRequest,
  MCPResponse,
  MCPError,
  MCPToolResult,
  MCPToolExecutor,
} from './mcp-server-adapter.js';

// MCP Gear Adapter — wraps MCP servers as Gear
export {
  mcpToolToGearAction,
  discoverMCPServer,
  MCPGearAdapter,
} from './mcp-gear-adapter.js';
export type {
  MCPGearAdapterConfig,
  MCPGearAdapterLogger,
  MCPTransport,
} from './mcp-gear-adapter.js';
