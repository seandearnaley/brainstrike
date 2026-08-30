import { toMcpVersionNegotiation } from '@brainstrike/agent';
import type { McpServerStatusSnapshot } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServer } from '../mcp-loader';
import {
  connectedStatus,
  type McpClient,
  type McpDiscoveredTool,
  mcpStatusErrorMessage,
} from './types';

const logger = createLogger('DesktopStdioMcpClient');
const CLOSED_ERROR_MESSAGE = 'Explicit stdio MCP client is closed';
const DEFAULT_STDIO_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_STDIO_CONNECT_FAILURE_COOLDOWN_MS = 3000;

function assertStdioClientActive(disposed: boolean): void {
  if (disposed) {
    throw new Error(CLOSED_ERROR_MESSAGE);
  }
}

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
  const statusBase = {
    configuredProtocol: server.protocol ?? ('legacy' as const),
    name: server.name,
    transport: 'stdio' as const,
  };
  let connected: ConnectedClient | undefined;
  let connecting: ConnectedClient | undefined;
  let connectPromise: Promise<ConnectedClient> | undefined;
  let disposed = false;
  let lastConnectFailure:
    | {
        error: Error;
        failedAt: number;
      }
    | undefined;
  let status: McpServerStatusSnapshot = { ...statusBase, state: 'disconnected' };

  async function ensureConnected(): Promise<ConnectedClient> {
    assertStdioClientActive(disposed);
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
      status = { ...statusBase, state: 'connecting' };
      const client = new Client(
        { name: `brainstrike-desktop-${server.name}`, version: '0.1.0' },
        {
          capabilities: {},
          versionNegotiation: toMcpVersionNegotiation(server.protocol ?? 'legacy'),
        }
      );
      const transportOptions = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
      const transport = new StdioClientTransport(transportOptions);
      const next = { client, transport };
      connecting = next;
      client.onclose = () => {
        if (connected?.client === client) {
          connected = undefined;
          status = { ...statusBase, state: 'disconnected' };
        }
      };
      try {
        await client.connect(transport, { timeout: getConnectTimeoutMs() });
        assertStdioClientActive(disposed);
        connected = next;
        status = connectedStatus(client, statusBase);
        lastConnectFailure = undefined;
        logger.info('Connected MCP stdio client', {
          command: server.command,
          server: server.name,
        });
        return next;
      } catch (error) {
        const nextError = disposed ? new Error(CLOSED_ERROR_MESSAGE) : toError(error);
        if (!disposed) {
          status = { ...statusBase, error: mcpStatusErrorMessage(error), state: 'error' };
          lastConnectFailure = { error: nextError, failedAt: Date.now() };
          await transport.close().catch(() => undefined);
        }
        throw nextError;
      } finally {
        connecting = undefined;
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
      disposed = true;
      const current = connected ?? connecting;
      connected = undefined;
      lastConnectFailure = undefined;
      discoveredToolNames.clear();
      status = { ...statusBase, state: 'disconnected' };

      if (!current) {
        return;
      }

      try {
        await current.client.close();
      } finally {
        await current.transport.close();
      }
    },
    getStatus: () => status,
    listTools,
    name: server.name,
    supportsTool(toolId: string): boolean {
      return discoveredToolNames.has(toolId);
    },
    transport: 'stdio',
  } satisfies McpClient;
}
