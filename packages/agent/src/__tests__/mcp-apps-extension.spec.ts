import { MCP_APPS_CLIENT_CAPABILITY, MCP_APPS_EXTENSION_ID } from '@brainstrike/mcp-app-host';
import { describe, expect, it } from 'vitest';
import {
  MCP_APPS_CLIENT_EXTENSION_CONTRACT,
  registerMcpAppsClientCapability,
} from '../mcp/apps-extension';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';

describe('MCP Apps client capability', () => {
  it('advertises the complete capability without modern request contracts', () => {
    const registry = new McpClientExtensionRegistry();
    registerMcpAppsClientCapability(registry);

    expect(registry.toClientExtensionCapabilities()).toEqual({
      [MCP_APPS_EXTENSION_ID]: MCP_APPS_CLIENT_CAPABILITY,
    });
    expect(MCP_APPS_CLIENT_EXTENSION_CONTRACT.requests).toBeUndefined();
    expect(MCP_APPS_CLIENT_EXTENSION_CONTRACT.notifications).toBeUndefined();
  });
});
