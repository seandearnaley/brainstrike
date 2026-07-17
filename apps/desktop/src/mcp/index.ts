import type { McpConfig, McpServer } from '../mcp-loader';
import { createHttpClient } from './http-client';
import { createStdioClient } from './stdio-client';
import type { McpCallOptions, McpClient } from './types';

type ClientMap = Map<string, McpClient>;
let clients: ClientMap = new Map();

function unsupportedTransport(server: never): never {
  const transport = (server as { transport?: unknown }).transport;
  throw new Error(`Unsupported MCP transport: ${String(transport)}`);
}

export function initClients(config: McpConfig | { servers: McpServer[] }): void {
  // Intentional fire-and-forget: client disposal can outlive config replacement,
  // and stale shutdown errors should not block installing the new registry.
  void disposeClients();
  const next: ClientMap = new Map();
  for (const s of config.servers) {
    if (s.transport === 'stdio') {
      next.set(s.name, createStdioClient(s));
      continue;
    }
    if (s.transport === 'sse' || s.transport === 'streamable-http') {
      next.set(s.name, createHttpClient(s));
      continue;
    }
    unsupportedTransport(s);
  }
  clients = next;
}

export async function disposeClients(): Promise<void> {
  const arr = Array.from(clients.values());
  clients.clear();
  await Promise.allSettled(arr.map((c) => Promise.resolve(c.dispose())));
}

export function getClient(name: string): McpClient | undefined {
  return clients.get(name);
}

export async function callTool(
  tool: string,
  params?: Record<string, unknown>,
  opts?: McpCallOptions
): Promise<unknown> {
  const clientName = tool.includes('.') ? tool.slice(0, tool.indexOf('.')) : undefined;
  if (clientName) {
    const scopedClient = clients.get(clientName) || clients.get(clientName.toLowerCase());
    if (scopedClient) {
      return scopedClient.callTool(tool, params, opts);
    }
  }

  for (const client of clients.values()) {
    if (client.supportsTool(tool)) {
      return client.callTool(tool, params, opts);
    }
  }

  throw new Error(`No MCP client registered for tool '${tool}'`);
}

export type { McpClient } from './types';
