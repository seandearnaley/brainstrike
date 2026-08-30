import { ExplicitHttpMcpClient } from '@brainstrike/agent/mcp-client';
import type { McpServerStatusSnapshot } from '@brainstrike/assistant-contract';
import type { McpServer } from '../mcp-loader';
import {
  connectedStatus,
  type McpCallOptions,
  type McpClient,
  type McpDiscoveredTool,
  mcpStatusErrorMessage,
} from './types';

type HttpMcpServer = Extract<McpServer, { transport: 'sse' | 'streamable-http' }>;
const CLOSED_ERROR_MESSAGE = 'Explicit HTTP MCP client is closed';

function assertHttpClientActive(disposed: boolean): void {
  if (disposed) {
    throw new Error(CLOSED_ERROR_MESSAGE);
  }
}

export function createHttpClient(server: HttpMcpServer): McpClient {
  const client = new ExplicitHttpMcpClient({
    ...(server.headers ? { headers: server.headers } : {}),
    clientInfo: { name: `brainstrike-desktop-${server.name}`, version: '0.1.0' },
    name: server.name,
    protocol: server.protocol ?? 'legacy',
    transport: server.transport,
    url: server.url,
  });
  const discoveredToolNames = new Map<string, string>();
  const statusBase = {
    configuredProtocol: server.protocol ?? ('legacy' as const),
    name: server.name,
    transport: server.transport,
  };
  let disposed = false;
  let status: McpServerStatusSnapshot = { ...statusBase, state: 'disconnected' };

  async function discoverTools(signal?: AbortSignal): Promise<Record<string, McpDiscoveredTool>> {
    assertHttpClientActive(disposed);
    status = { ...statusBase, state: 'connecting' };
    let result: Awaited<ReturnType<typeof client.listTools>>;
    try {
      result = await client.listTools(signal ? { signal } : undefined);
      assertHttpClientActive(disposed);
      status = connectedStatus(client, statusBase);
    } catch (error) {
      status = disposed
        ? status
        : { ...statusBase, error: mcpStatusErrorMessage(error), state: 'error' };
      throw error;
    }
    const discovered: Record<string, McpDiscoveredTool> = {};
    const nextToolNames = new Map<string, string>();

    for (const tool of result.tools) {
      const toolId = `${server.name}.${tool.name}`;
      if (nextToolNames.has(toolId)) {
        throw new Error(`Duplicate MCP tool ID discovered for server '${server.name}': ${toolId}`);
      }
      nextToolNames.set(toolId, tool.name);
      discovered[toolId] = {
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      };
    }

    discoveredToolNames.clear();
    for (const [toolId, rawToolName] of nextToolNames) {
      discoveredToolNames.set(toolId, rawToolName);
    }
    return discovered;
  }

  return {
    async callTool(
      toolId: string,
      params?: Record<string, unknown>,
      opts?: McpCallOptions
    ): Promise<unknown> {
      if (!discoveredToolNames.has(toolId)) {
        await discoverTools(opts?.signal);
      }

      const rawToolName = discoveredToolNames.get(toolId);
      if (!rawToolName) {
        throw new Error(`Unsupported MCP tool: ${toolId}`);
      }

      return await client.callTool(
        {
          arguments: params ?? {},
          name: rawToolName,
        },
        {
          ...(opts?.onProgress
            ? {
                onprogress: (payload) => {
                  opts.onProgress?.(payload);
                },
              }
            : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
          resetTimeoutOnProgress: true,
        }
      );
    },
    async dispose(): Promise<void> {
      disposed = true;
      status = { ...statusBase, state: 'disconnected' };
      discoveredToolNames.clear();
      try {
        await client.close();
      } finally {
        discoveredToolNames.clear();
      }
    },
    getStatus: () => status,
    listTools: discoverTools,
    name: server.name,
    supportsTool(toolId: string): boolean {
      return !disposed && discoveredToolNames.has(toolId);
    },
    transport: server.transport,
  } satisfies McpClient;
}
