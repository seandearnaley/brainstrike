import {
  MCP_APPS_CLIENT_CAPABILITY,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_SPEC_VERSION,
  type McpAppsClientCapability,
  parseMcpAppsClientCapability,
} from '@brainstrike/mcp-app-host/capabilities';
import type { JSONObject } from '@modelcontextprotocol/client';
import type {
  McpClientExtensionContract,
  McpClientExtensionRegistry,
} from './client-extension-registry';

const MCP_APPS_CLIENT_IMPLEMENTATION = Object.freeze({ capabilityOnly: true as const });
type McpAppsClientSettings = McpAppsClientCapability & JSONObject;

export const MCP_APPS_CLIENT_EXTENSION_CONTRACT: McpClientExtensionContract<
  typeof MCP_APPS_SPEC_VERSION,
  McpAppsClientSettings,
  typeof MCP_APPS_CLIENT_IMPLEMENTATION
> = Object.freeze({
  id: MCP_APPS_EXTENSION_ID,
  isCompleteImplementation: (value: unknown): value is typeof MCP_APPS_CLIENT_IMPLEMENTATION =>
    value === MCP_APPS_CLIENT_IMPLEMENTATION,
  parseSettings: parseMcpAppsClientCapability as (value: unknown) => McpAppsClientSettings,
  version: MCP_APPS_SPEC_VERSION,
});

export function registerMcpAppsClientCapability(registry: McpClientExtensionRegistry): void {
  registry.register(MCP_APPS_CLIENT_EXTENSION_CONTRACT, {
    implementation: MCP_APPS_CLIENT_IMPLEMENTATION,
    settings: MCP_APPS_CLIENT_CAPABILITY as McpAppsClientSettings,
    version: MCP_APPS_SPEC_VERSION,
  });
}
