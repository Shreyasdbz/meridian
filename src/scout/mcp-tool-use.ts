// @meridian/scout — MCP Tool Use (Section 9.4)
// Native MCP tool-use integration for Scout.
// When the LLM provider supports MCP tool-use protocol natively,
// Scout can bypass custom tool-calling logic.

import type {
  GearManifest,
  MCPToolDefinition,
  ToolDefinition,
} from '@meridian/shared';

// ---------------------------------------------------------------------------
// Providers known to support native MCP tool-use
// ---------------------------------------------------------------------------

/**
 * Set of provider names that support native MCP tool-use protocol.
 *
 * As of v0.4, Anthropic supports MCP tool-use natively via the
 * tool_use content block format. Other providers may be added as
 * they adopt the protocol.
 */
const MCP_NATIVE_PROVIDERS = new Set<string>([
  'anthropic',
]);

// ---------------------------------------------------------------------------
// Conversion: Gear manifests -> MCP tool definitions
// ---------------------------------------------------------------------------

/**
 * Convert an array of Gear manifests to MCP-compatible tool definitions.
 *
 * Each Gear action becomes a separate MCP tool with name format
 * "gearId.actionName" to ensure global uniqueness.
 *
 * @param manifests - Gear manifests to convert
 * @returns Array of MCP tool definitions
 */
export function gearToMCPTools(
  manifests: GearManifest[],
): MCPToolDefinition[] {
  const tools: MCPToolDefinition[] = [];

  for (const manifest of manifests) {
    for (const action of manifest.actions) {
      tools.push({
        name: `${manifest.id}.${action.name}`,
        description: action.description,
        inputSchema: action.parameters,
      });
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Conversion: MCP tool definitions -> Provider ToolDefinitions
// ---------------------------------------------------------------------------

/**
 * Convert MCP tool definitions to Meridian's internal ToolDefinition format
 * for passing to LLM providers.
 *
 * The formats are structurally identical (name, description, inputSchema),
 * but this function provides a clean mapping boundary between the MCP
 * protocol types and the provider abstraction.
 *
 * @param tools - MCP tool definitions to convert
 * @returns Array of provider-compatible ToolDefinitions
 */
export function mcpToProviderTools(
  tools: MCPToolDefinition[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// Provider capability check
// ---------------------------------------------------------------------------

/**
 * Check if an LLM provider supports native MCP tool-use protocol.
 *
 * When a provider supports native MCP, Scout can send tool definitions
 * in MCP format directly without translating to provider-specific schemas.
 * This enables features like:
 * - Streaming tool-use responses
 * - Provider-managed tool execution
 * - Reduced format translation overhead
 *
 * @param providerName - The provider name (e.g., 'anthropic', 'openai')
 * @returns True if the provider supports native MCP tool-use
 */
export function supportsNativeMCP(providerName: string): boolean {
  return MCP_NATIVE_PROVIDERS.has(providerName.toLowerCase());
}
