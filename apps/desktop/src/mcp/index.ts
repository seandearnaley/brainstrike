import type { McpConfig, McpServer } from '../mcp-loader';
import { createSseClient } from './sse-client';
import { createFilesystemClientFromStdio } from './stdio-client';
import type { McpClient } from './types';

type ClientMap = Map<string, McpClient>;
let clients: ClientMap = new Map();

export function initClients(config: McpConfig | { servers: McpServer[] }): void {
  void disposeClients();
  const next: ClientMap = new Map();
  for (const s of config.servers) {
    if (s.transport === 'stdio' && s.name.toLowerCase().includes('filesystem')) {
      next.set(s.name, createFilesystemClientFromStdio(s));
      continue;
    }
    if (s.transport === 'sse') {
      next.set(s.name, createSseClient(s));
      continue;
    }
    next.set(s.name, {
      name: s.name,
      transport: s.transport,
      dispose: async () => {},
      async callTool(tool: string): Promise<unknown> {
        throw new Error(
          `MCP ${s.transport} client for '${s.name}' not implemented for tool '${tool}'.`
        );
      },
    });
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
  opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
): Promise<unknown> {
  const clientName = tool.includes('.') ? tool.slice(0, tool.indexOf('.')) : tool;
  const client = clients.get(clientName) || clients.get(clientName.toLowerCase());
  if (!client) {
    throw new Error(`No MCP client registered for '${clientName}'`);
  }
  return client.callTool(tool, params, opts);
}

export type { McpClient } from './types';
