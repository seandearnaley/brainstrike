import { createLogger } from '@brainstrike/utils/logger';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '../mcp-loader';
import type { McpClient, McpDiscoveredTool } from './types';

const logger = createLogger('DesktopStdioMcpClient');
const DEFAULT_STDIO_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_STDIO_CONNECT_FAILURE_COOLDOWN_MS = 3000;

interface ConnectedClient {
  client: Client;
  transport: StdioClientTransport;
}

function getConnectTimeoutMs(): number {
  const raw = Number(
    process.env['MCP_STDIO_CONNECT_TIMEOUT_MS'] ?? DEFAULT_STDIO_CONNECT_TIMEOUT_MS
  );
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_STDIO_CONNECT_TIMEOUT_MS;
}

function getConnectFailureCooldownMs(): number {
  const raw = Number(
    process.env['MCP_STDIO_CONNECT_FAILURE_COOLDOWN_MS'] ??
      DEFAULT_STDIO_CONNECT_FAILURE_COOLDOWN_MS
  );
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return DEFAULT_STDIO_CONNECT_FAILURE_COOLDOWN_MS;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function createStdioClient(server: Extract<McpServer, { transport: 'stdio' }>): McpClient {
  const discoveredToolNames = new Map<string, string>();
  let connected: ConnectedClient | undefined;
  let connectPromise: Promise<ConnectedClient> | undefined;
  let lastConnectFailure:
    | {
        error: Error;
        failedAt: number;
      }
    | undefined;

  async function ensureConnected(): Promise<ConnectedClient> {
    if (connected) {
      return connected;
    }
    if (connectPromise) {
      return connectPromise;
    }
    if (lastConnectFailure) {
      const elapsedMs = Date.now() - lastConnectFailure.failedAt;
      if (elapsedMs < getConnectFailureCooldownMs()) {
        throw lastConnectFailure.error;
      }
      lastConnectFailure = undefined;
    }

    connectPromise = (async () => {
      const client = new Client(
        { name: `brainstrike-desktop-${server.name}`, version: '0.1.0' },
        { capabilities: {} }
      );
      const transportOptions = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
      const transport = new StdioClientTransport(transportOptions);
      try {
        await client.connect(transport, { timeout: getConnectTimeoutMs() });
        const next = { client, transport };
        connected = next;
        lastConnectFailure = undefined;
        logger.info('Connected MCP stdio client', {
          command: server.command,
          server: server.name,
        });
        return next;
      } catch (error) {
        const nextError = toError(error);
        lastConnectFailure = {
          error: nextError,
          failedAt: Date.now(),
        };
        await transport.close().catch(() => undefined);
        throw nextError;
      }
    })().finally(() => {
      connectPromise = undefined;
    });

    return connectPromise;
  }

  async function listTools(): Promise<Record<string, McpDiscoveredTool>> {
    const { client } = await ensureConnected();
    const result = await client.listTools();
    const discovered: Record<string, McpDiscoveredTool> = {};
    discoveredToolNames.clear();

    for (const tool of result.tools) {
      const toolId = `${server.name}.${tool.name}`;
      if (discoveredToolNames.has(toolId)) {
        throw new Error(`Duplicate MCP tool ID discovered for server '${server.name}': ${toolId}`);
      }
      discoveredToolNames.set(toolId, tool.name);
      discovered[toolId] = {
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      };
    }

    return discovered;
  }

  return {
    async callTool(
      toolId: string,
      params?: Record<string, unknown>,
      opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
    ): Promise<unknown> {
      if (!discoveredToolNames.has(toolId)) {
        await listTools();
      }

      const rawToolName = discoveredToolNames.get(toolId);
      if (!rawToolName) {
        throw new Error(`Unsupported MCP tool: ${toolId}`);
      }

      const { client } = await ensureConnected();
      return await client.callTool(
        {
          arguments: params ?? {},
          name: rawToolName,
        },
        undefined,
        {
          ...(opts?.onProgress
            ? {
                onprogress: (payload) => {
                  opts.onProgress?.(payload, {});
                },
              }
            : {}),
          resetTimeoutOnProgress: true,
        }
      );
    },
    async dispose(): Promise<void> {
      const current = connected;
      connected = undefined;
      lastConnectFailure = undefined;
      discoveredToolNames.clear();

      if (!current) {
        return;
      }

      try {
        await current.client.close();
      } finally {
        await current.transport.close();
      }
    },
    listTools,
    name: server.name,
    supportsTool(toolId: string): boolean {
      return discoveredToolNames.has(toolId);
    },
    transport: 'stdio',
  } satisfies McpClient;
}
