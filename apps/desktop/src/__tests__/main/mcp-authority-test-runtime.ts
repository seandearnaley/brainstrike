import {
  type ConfiguredMcpServerId,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostPort,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { vi } from 'vitest';
import type { ResolvedMcpConfig } from '../../mcp-loader';

type ListToolsResult = Extract<McpHostOperationResult, { type: 'tools/list' }>['result'];

export function createMcpAuthorityTestRuntime(
  listTools: (serverId: ConfiguredMcpServerId) => Promise<ListToolsResult> = async () => ({
    tools: [],
  })
) {
  let current: McpHostSnapshot = { revision: 0, servers: [] };
  const invoke = vi.fn(async (operation: McpHostOperation): Promise<McpHostOperationResult> => {
    if (operation.type !== 'tools/list') {
      throw new Error('Test authority runtime only supports tools/list');
    }
    return { result: await listTools(operation.configuredServerId), type: 'tools/list' } as const;
  });
  const replaceResolvedConfig = vi.fn(async (config: ResolvedMcpConfig) => {
    current = {
      revision: current.revision + 1,
      servers: config.servers.map((server) => ({
        configuredProtocol: server.protocol,
        configuredServerId: parseConfiguredMcpServerId(server.name),
        generation: current.revision + 1,
        state:
          server.startup === 'authentication-required' ? 'authentication-required' : 'disconnected',
        transport: server.transport,
      })),
    };
    return current;
  });

  const host: McpHostPort = {
    close: vi.fn(async () => ({
      callbacksClosed: 0,
      childProcessesClosed: 0,
      clientsClosed: 0,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    })),
    control: vi.fn(async (request) => {
      const server = current.servers.find(
        ({ configuredServerId }) => configuredServerId === request.configuredServerId
      );
      if (!server) {
        throw new Error('Test MCP server is not configured');
      }
      return structuredClone(server);
    }),
    invoke,
    replaceConfig: vi.fn(async () => current),
    snapshot: () => current,
    watch: vi.fn(() => vi.fn()),
  };

  return {
    invoke,
    replaceResolvedConfig,
    runtime: {
      host,
      replaceResolvedConfig,
    },
  };
}
