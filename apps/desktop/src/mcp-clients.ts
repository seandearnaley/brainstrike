import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpConfig, McpServer } from './mcp-loader';

export interface McpClient {
  name: string;
  transport: 'stdio' | 'sse';
  dispose: () => Promise<void> | void;
  // Generic tool call surface; returns arbitrary JSON-serializable payload
  callTool: (tool: string, params?: Record<string, unknown>) => Promise<unknown>;
}

type ClientMap = Map<string, McpClient>;

let clients: ClientMap = new Map();

function expandHome(p: string): string {
  if (p.startsWith('~/'))
    return path.join(
      (process.env['HOME'] as string | undefined) ||
        (process.env['USERPROFILE'] as string | undefined) ||
        '',
      p.slice(2)
    );
  return p;
}

function resolveBaseDirFromArgs(args?: string[]): string | null {
  if (!args || args.length === 0) return null;
  const candidate = args[args.length - 1];
  if (!candidate) return null;
  return expandHome(candidate);
}

function createFilesystemClientFromStdio(
  server: Extract<McpServer, { transport: 'stdio' }>
): McpClient {
  // For now, we provide a pragmatic implementation that uses Node's fs
  // to satisfy a demo of `filesystem.list` rather than speaking full MCP.
  // We still optionally spawn the configured process to validate presence,
  // but we don't depend on its protocol yet.
  const baseDir = resolveBaseDirFromArgs(server.args) || process.cwd();
  let child: ChildProcess | null = null;
  try {
    // Best-effort spawn in background; ignore failures
    child = spawn(server.command, server.args ?? [], {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: 'ignore',
      detached: true,
    });
    // Detach so it doesn't keep the event loop alive
    child.unref();
  } catch {
    // ignore
  }

  return {
    name: server.name,
    transport: 'stdio',
    dispose: async () => {
      try {
        if (child) child.kill();
      } catch {}
    },
    async callTool(tool: string, params?: Record<string, unknown>): Promise<unknown> {
      if (tool !== 'filesystem.list') throw new Error(`Unsupported tool: ${tool}`);
      const p =
        typeof params?.['path'] === 'string' && (params['path'] as string).length > 0
          ? (params['path'] as string)
          : baseDir;
      const dir = expandHome(p);
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  } satisfies McpClient;
}

function createPlaceholderClient(server: McpServer): McpClient {
  return {
    name: server.name,
    transport: server.transport,
    dispose: async () => {},
    async callTool(tool: string, _params?: Record<string, unknown>): Promise<unknown> {
      throw new Error(
        `MCP ${server.transport} client for '${server.name}' not implemented for tool '${tool}'.`
      );
    },
  } satisfies McpClient;
}

function createSseClient(server: Extract<McpServer, { transport: 'sse' }>): McpClient {
  // Lazy background connector; ignores failures to remain non-fatal in tests/CI
  const ctrl = new AbortController();
  const headers = new Headers();
  for (const [k, v] of Object.entries(server.headers ?? {})) headers.set(k, v);
  void (async () => {
    try {
      const res = await fetch(server.url, {
        method: 'GET',
        headers,
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Minimal SSE line handling; discard content
        const idx = buf.lastIndexOf('\n');
        if (idx >= 0) buf = buf.slice(idx + 1);
      }
    } catch {
      // ignore connection failures
    }
  })();

  return {
    name: server.name,
    transport: 'sse',
    dispose: async () => {
      try {
        ctrl.abort();
      } catch {}
    },
    async callTool(tool: string, params?: Record<string, unknown>): Promise<unknown> {
      // Minimal HTTP call convention: POST to <base>/call with { tool, params }
      // Allows demo servers to implement a simple handler alongside SSE.
      try {
        const base = server.url.replace(/\/?sse$/, '');
        const callPath = (process.env['MCP_SSE_CALL_PATH'] as string | undefined) ?? '/call';
        const url = base + callPath;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...Object.fromEntries(headers.entries()),
          },
          body: JSON.stringify({ tool, params: params ?? {} }),
          signal: ctrl.signal,
        });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const json = await res.json().catch(() => null);
        return json ?? { ok: true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  } satisfies McpClient;
}

export function initClients(config: McpConfig | { servers: McpServer[] }): void {
  // Dispose existing
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
    next.set(s.name, createPlaceholderClient(s));
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

export async function callTool(tool: string, params?: Record<string, unknown>): Promise<unknown> {
  // Tool name prefix convention: '<client>.<tool>' e.g., 'filesystem.list'
  const clientName = tool.includes('.') ? tool.slice(0, tool.indexOf('.')) : tool;
  const client = clients.get(clientName) || clients.get(clientName.toLowerCase());
  if (!client) throw new Error(`No MCP client registered for '${clientName}'`);
  return client.callTool(tool, params);
}
