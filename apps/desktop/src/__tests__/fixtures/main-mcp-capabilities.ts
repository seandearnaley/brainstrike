import type { DesktopMcpPlatformCapabilities } from '../../agent-host-platform/mcp-main-stores';
import { RemoteMcpRuntime } from '../../mcp/remote-runtime';

function unexpected(store: string): never {
  throw new Error(`This scenario configures no MCP server, so Main's ${store} must not be used`);
}

/**
 * Main's MCP capabilities for a scenario with no configured MCP server: the
 * Node host still composes its one runtime (empty), and any store use fails.
 */
export function emptyMainMcpCapabilities(): DesktopMcpPlatformCapabilities {
  return {
    listCredentials: async () => unexpected('credential list'),
    oauth: {
      clear: async () => unexpected('OAuth store'),
      clearAll: async () => unexpected('OAuth store'),
      read: async () => unexpected('OAuth store'),
      write: async () => unexpected('OAuth store'),
    },
    openExternal: async () => unexpected('external opener'),
    queryTasks: async () => unexpected('Tasks database'),
    readCredential: async () => unexpected('credential store'),
    runtime: new RemoteMcpRuntime({ getAllTools: () => ({}), subscribe: () => () => undefined }),
  };
}
