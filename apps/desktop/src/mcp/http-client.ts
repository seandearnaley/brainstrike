import { ExplicitHttpMcpClient, type ExplicitHttpMcpTool } from '@brainstrike/agent/mcp-client';
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

function buildDiscoveredTools(
  serverName: string,
  tools: readonly ExplicitHttpMcpTool[]
): {
  definitions: Map<string, ExplicitHttpMcpTool>;
  names: Map<string, string>;
  projection: Record<string, McpDiscoveredTool>;
} {
  const definitions = new Map<string, ExplicitHttpMcpTool>();
  const names = new Map<string, string>();
  const projection: Record<string, McpDiscoveredTool> = {};
  for (const tool of tools) {
    const toolId = `${serverName}.${tool.name}`;
    if (names.has(toolId)) {
      throw new Error(`Duplicate MCP tool ID discovered for server '${serverName}': ${toolId}`);
    }
    names.set(toolId, tool.name);
    definitions.set(toolId, tool);
    projection[toolId] = {
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    };
  }
  return { definitions, names, projection };
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
  const discoveredToolDefinitions = new Map<string, ExplicitHttpMcpTool>();
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
    const next = buildDiscoveredTools(server.name, result.tools);
    discoveredToolNames.clear();
    discoveredToolDefinitions.clear();
    for (const [toolId, rawToolName] of next.names) {
      discoveredToolNames.set(toolId, rawToolName);
    }
    for (const [toolId, tool] of next.definitions) {
      discoveredToolDefinitions.set(toolId, tool);
    }
    return next.projection;
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

      const toolDefinition = discoveredToolDefinitions.get(toolId);
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
          ...(toolDefinition === undefined ? {} : { toolDefinition }),
          resetTimeoutOnProgress: true,
        }
      );
    },
    async dispose(): Promise<void> {
      disposed = true;
      status = { ...statusBase, state: 'disconnected' };
      discoveredToolNames.clear();
      discoveredToolDefinitions.clear();
      try {
        await client.close();
      } finally {
        discoveredToolNames.clear();
        discoveredToolDefinitions.clear();
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
