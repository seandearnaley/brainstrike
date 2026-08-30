import { ExplicitStdioMcpClient } from '@brainstrike/agent/mcp-client';
import type { McpServerStatusSnapshot } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { McpServer } from '../mcp-loader';
import {
  connectedStatus,
  type McpCallOptions,
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
  client: ExplicitStdioMcpClient;
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
      const client = new ExplicitStdioMcpClient({
        clientInfo: { name: `brainstrike-desktop-${server.name}`, version: '0.1.0' },
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        name: server.name,
        onUnexpectedClose: () => {
          if (connected?.client === client) {
            connected = undefined;
            discoveredToolNames.clear();
            status = { ...statusBase, state: 'disconnected' };
          }
        },
        protocol: server.protocol ?? 'legacy',
      });
      const next = { client };
      connecting = next;
      try {
        await client.connect({ timeout: getConnectTimeoutMs() });
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
          // The explicit client owns the SDK client and transport. The SDK
          // binds transport ownership before spawn/handshake work begins.
          await client.close().catch(() => undefined);
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
      opts?: McpCallOptions
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
          ...(opts?.signal ? { signal: opts.signal } : {}),
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

      await current.client.close();
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
