/**
 * Host-owned MCP extension registration and task-host defaults (BST-1566),
 * split from `host-runtime.ts` to keep that file within its size budget.
 */
import {
  McpClientExtensionRegistry,
  registerMcpAppsClientCapability,
  registerMcpTasksWireContracts,
} from '@brainstrike/agent/mcp-client';
import {
  hasNoEnabledMcpExtension,
  type McpExtensionEnablement,
  resolveMcpExtensionEnablement,
} from '@brainstrike/assistant-contract';
import type { ResolvedMcpServer } from '@brainstrike/assistant-contract/mcp-config';
import type { ExplicitClient } from './host-connection.js';
import type { McpTaskConnectionClient } from './task-host.js';

/**
 * Effective registered-extension state for one connection (BST-1604).
 *
 * The resolved server already carries the global preference folded into its
 * own override (`applyMcpExtensionPreferences`), so this is a pure read plus
 * the transport rule: the legacy `sse` transport never negotiates the
 * `2026-07-28` revision registered extensions require, so nothing is ever
 * enabled on it regardless of either dial.
 */
export function resolveMcpServerExtensions(server: ResolvedMcpServer): McpExtensionEnablement {
  switch (server.transport) {
    case 'stdio':
    case 'streamable-http':
      return resolveMcpExtensionEnablement(server.extensions);
    case 'sse':
      return { apps: false, tasks: false };
    default:
      throw new Error(`Unsupported MCP transport for extension registration: ${String(server)}`);
  }
}

/**
 * Production extension registration: the MCP Apps client capability and the
 * complete MCP Tasks wire contracts, each installed only while its effective
 * state is enabled. A server with neither enabled — and every `sse`
 * connection — gets no registry at all rather than an advertisement it cannot
 * honor, so `initialize` omits `capabilities.extensions` outright.
 */
export function createDefaultMcpExtensionRegistry(
  server: ResolvedMcpServer
): McpClientExtensionRegistry | undefined {
  const enabled = resolveMcpServerExtensions(server);
  if (hasNoEnabledMcpExtension(enabled)) {
    return undefined;
  }
  const registry = new McpClientExtensionRegistry();
  if (enabled.apps) {
    registerMcpAppsClientCapability(registry);
  }
  if (enabled.tasks) {
    registerMcpTasksWireContracts(registry);
  }
  return registry;
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
