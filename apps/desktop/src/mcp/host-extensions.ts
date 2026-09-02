/**
 * Host-owned MCP extension registration and task-host defaults (BST-1566),
 * split from `host-runtime.ts` to keep that file within its size budget.
 */
import {
  McpClientExtensionRegistry,
  registerMcpAppsClientCapability,
  registerMcpTasksWireContracts,
} from '@brainstrike/agent/mcp-client';
import type { McpTaskDatabase } from '@brainstrike/db';
import type { ResolvedMcpServer } from '../mcp-loader';
import type { ExplicitClient } from './host-runtime';
import type { McpTaskConnectionClient } from './task-host';

/**
 * Production extension registration: the complete MCP Tasks wire contracts on
 * stdio and streamable-http. The legacy `sse` transport never negotiates the
 * `2026-07-28` revision that registered extensions require, so it gets no
 * registry at all rather than an advertisement it cannot honor. A later Apps
 * host stacks its registration onto the same fresh registry here.
 */
export function createDefaultMcpExtensionRegistry(
  server: ResolvedMcpServer
): McpClientExtensionRegistry | undefined {
  switch (server.transport) {
    case 'stdio':
    case 'streamable-http': {
      const registry = new McpClientExtensionRegistry();
      registerMcpAppsClientCapability(registry);
      registerMcpTasksWireContracts(registry);
      return registry;
    }
    case 'sse':
      return undefined;
    default:
      throw new Error(`Unsupported MCP transport for extension registration: ${String(server)}`);
  }
}

export function requireTaskConnectionClient(
  client: ExplicitClient,
  server: ResolvedMcpServer
): McpTaskConnectionClient {
  // Both production clients carry the surface; it is only exercised once a
  // server actually advertises Tasks, and a missing method fails there loudly.
  const missing = (operation: string): never => {
    throw new Error(
      `MCP client for "${server.name}" has no registered-extension ${operation} surface.`
    );
  };
  return {
    getNegotiatedProtocolVersion: () => client.getNegotiatedProtocolVersion(),
    getServerCapabilities: () => client.getServerCapabilities(),
    listenTasks: (taskIds, handler, options) =>
      typeof client.listenTasks === 'function'
        ? client.listenTasks(taskIds, handler, options)
        : missing('notification'),
    requestExtension: (contract, params, options) =>
      typeof client.requestExtension === 'function'
        ? client.requestExtension(contract, params, options)
        : missing('request'),
  };
}

export function createDefaultTaskDatabaseOpener(): () => Promise<McpTaskDatabase> {
  return async () => {
    const { getDatabase } = await import('../db-main');
    const database = await getDatabase();
    return { query: (sql, params) => database.query(sql, params) };
  };
}
