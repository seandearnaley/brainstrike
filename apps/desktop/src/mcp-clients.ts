import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpConfig, McpServer } from './mcp-loader';

type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  onProgress?: (payload: unknown, meta?: { id?: string }) => void;
};

export interface McpClient {
  name: string;
  transport: 'stdio' | 'sse';
  dispose: () => Promise<void> | void;
  // Generic tool call surface; returns arbitrary JSON-serializable payload
  callTool: (
    tool: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
  ) => Promise<unknown>;
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

function normalizeRootDir(dir: string): string {
  return path.resolve(expandHome(dir));
}

function isPathInsideRoot(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

type ResolvedPathResult = { ok: true; path: string } | { ok: false; error: string };

async function resolvePathWithinRoot(
  rootDir: string,
  requested: unknown
): Promise<ResolvedPathResult> {
  const base = path.resolve(rootDir);
  const baseReal = await fs.realpath(base).catch(() => base);
  const raw = typeof requested === 'string' && requested.trim().length > 0 ? requested : '.';
  const expanded = expandHome(raw);
  const candidate = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseReal, expanded);

  try {
    const real = await fs.realpath(candidate);
    if (!isPathInsideRoot(baseReal, real)) {
      return { ok: false, error: 'Resolved path is outside the configured root.' };
    }
    return { ok: true, path: real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      if (!isPathInsideRoot(baseReal, candidate)) {
        return { ok: false, error: 'Requested path is outside the configured root.' };
      }
      // Path does not exist yet but the resolved path is still within the root boundary
      return { ok: true, path: candidate };
    }
    throw error;
  }
}

function resolveBaseDirFromArgs(args?: string[]): string | null {
  if (!args || args.length === 0) return null;
  const candidate = args[args.length - 1];
  if (!candidate) return null;
  return expandHome(candidate);
}

async function handleFilesystemList(
  params: Record<string, unknown> | undefined,
  rootDir: string
): Promise<unknown> {
  const resolved = await resolvePathWithinRoot(rootDir, params?.['path']);
  if (!resolved.ok) return { error: resolved.error };
  try {
    const entries = await fs.readdir(resolved.path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function handleFilesystemRead(
  params: Record<string, unknown> | undefined,
  rootDir: string
): Promise<unknown> {
  const resolved = await resolvePathWithinRoot(rootDir, params?.['path']);
  if (!resolved.ok) return { error: resolved.error };
  const filePath = resolved.path;
  const encoding =
    (typeof params?.['encoding'] === 'string' ? (params['encoding'] as string) : 'utf8') || 'utf8';
  const maxBytesRaw =
    typeof params?.['maxBytes'] === 'number' ? (params['maxBytes'] as number) : undefined;
  const maxBytes =
    Number.isFinite(maxBytesRaw as number) && (maxBytesRaw as number) > 0
      ? (maxBytesRaw as number)
      : 16 * 1024;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) return { error: 'path is a directory' };
    const fh = await fs.open(filePath, 'r');
    try {
      const size = stat.size;
      const toRead = Math.min(size, maxBytes);
      const buf = Buffer.allocUnsafe(toRead);
      await fh.read(buf, 0, toRead, 0);
      const truncated = size > toRead;
      const content = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
      return {
        path: filePath,
        size,
        encoding,
        content,
        truncated,
      };
    } finally {
      await fh.close();
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: BFS with filtering and capping kept inline for clarity
async function handleFilesystemSearch(
  params: Record<string, unknown> | undefined,
  rootDir: string
): Promise<unknown> {
  const q = typeof params?.['query'] === 'string' ? (params['query'] as string) : '';
  if (!q) return { error: 'query is required' };
  const start = await resolvePathWithinRoot(rootDir, params?.['path']);
  if (!start.ok) return { error: start.error };
  const root = start.path;
  const baseRoot = await fs.realpath(rootDir).catch(() => path.resolve(rootDir));
  const maxResultsRaw =
    typeof params?.['maxResults'] === 'number' ? (params['maxResults'] as number) : undefined;
  const maxResults =
    Number.isFinite(maxResultsRaw as number) && (maxResultsRaw as number) > 0
      ? (maxResultsRaw as number)
      : 50;
  const maxDepthRaw =
    typeof params?.['maxDepth'] === 'number' ? (params['maxDepth'] as number) : undefined;
  const maxDepth =
    Number.isFinite(maxDepthRaw as number) && (maxDepthRaw as number) > 0
      ? (maxDepthRaw as number)
      : 3;
  const ignore = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', 'coverage']);
  const lcQuery = q.toLowerCase();
  type Item = { name: string; path: string; type: 'file' | 'dir' };
  const results: Item[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  try {
    while (queue.length > 0 && results.length < maxResults) {
      const next = queue.shift();
      if (!next) break;
      const { dir, depth } = next;
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (results.length >= maxResults) break;
        const itemPath = path.join(dir, e.name);
        if (ignore.has(e.name)) continue;
        if (!isPathInsideRoot(baseRoot, path.resolve(itemPath))) continue;
        if (e.isSymbolicLink?.()) continue;
        if (e.isDirectory()) {
          if (e.name.toLowerCase().includes(lcQuery)) {
            results.push({ name: e.name, path: itemPath, type: 'dir' });
          }
          if (depth < maxDepth) queue.push({ dir: itemPath, depth: depth + 1 });
          continue;
        }
        // files
        if (e.name.toLowerCase().includes(lcQuery)) {
          results.push({ name: e.name, path: itemPath, type: 'file' });
        }
      }
    }
    return results;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function createFilesystemClientFromStdio(
  server: Extract<McpServer, { transport: 'stdio' }>
): McpClient {
  // For now, we provide a pragmatic implementation that uses Node's fs
  // to satisfy a demo of `filesystem.list` rather than speaking full MCP.
  // We still optionally spawn the configured process to validate presence,
  // but we don't depend on its protocol yet.
  const baseDirArg = resolveBaseDirFromArgs(server.args) ?? process.cwd();
  const rootDir = normalizeRootDir(baseDirArg);
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
    async callTool(
      tool: string,
      params?: Record<string, unknown>,
      _opts?: { onProgress?: (payload: unknown) => void }
    ): Promise<unknown> {
      switch (tool) {
        case 'filesystem.list':
          return await handleFilesystemList(params, rootDir);
        case 'filesystem.read':
          return await handleFilesystemRead(params, rootDir);
        case 'filesystem.search':
          return await handleFilesystemSearch(params, rootDir);
        default:
          throw new Error(`Unsupported tool: ${tool}`);
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

function parseSseFrame(frame: string): {
  eventName: string;
  id?: string;
  payload: unknown;
} {
  const lines = frame.split(/\r?\n/);
  let eventName = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('id:')) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const dataText = dataLines.join('\n');
  let payload: unknown = dataText;
  try {
    payload = dataText ? JSON.parse(dataText) : {};
  } catch {
    // keep as text if not JSON
  }
  const result: { eventName: string; id?: string; payload: unknown } = {
    eventName,
    payload,
  };
  if (typeof id === 'string') result.id = id;
  return result;
}

function resolvePendingRequest(
  key: string,
  eventName: string,
  obj: { id?: string; ok?: boolean; result?: unknown; error?: unknown },
  pending: Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
  >
): void {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  clearTimeout(p.timer);

  if (eventName === 'tool-error' || (obj.ok === false && obj.error !== undefined)) {
    p.resolve({ error: obj.error });
  } else if ('result' in obj) {
    p.resolve(obj.result);
  } else {
    p.resolve(obj);
  }
}

function broadcastErrorToAllPending(payload: unknown, pending: Map<string, PendingEntry>): void {
  for (const [k, p] of pending.entries()) {
    clearTimeout(p.timer);
    p.resolve({ error: (payload as { error?: unknown }).error ?? 'error' });
    pending.delete(k);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

function extractKey(payload: unknown, fallbackId?: string): string | undefined {
  if (isObject(payload) && typeof payload['id'] === 'string' && payload['id'])
    return payload['id'] as string;
  return fallbackId;
}

function handleToolResult(
  eventName: string,
  payload: unknown,
  id: string | undefined,
  pending: Map<string, PendingEntry>
): void {
  switch (eventName) {
    case 'tool-result':
    case 'tool-error': {
      if (!isObject(payload)) return;
      const obj = payload as { id?: string; ok?: boolean; result?: unknown; error?: unknown };
      const key = extractKey(obj, id);
      if (key && pending.has(key)) {
        resolvePendingRequest(key, eventName, obj, pending);
        return;
      }
      if (!key && eventName === 'tool-error') {
        broadcastErrorToAllPending(payload, pending);
      }
      return;
    }
    case 'tool-progress': {
      const key = extractKey(payload, id);
      if (key) {
        const p = pending.get(key);
        p?.onProgress?.(payload, { id: key });
        return;
      }
      // broadcast when no request id provided
      for (const [k, p] of pending.entries()) p.onProgress?.(payload, { id: k });
      return;
    }
    default:
      return;
  }
}

async function handleSseRequest(
  requestId: string,
  tool: string,
  params: Record<string, unknown> | undefined,
  timer: NodeJS.Timeout,
  resolve: (value: unknown) => void,
  startReader: () => Promise<void>,
  pending: Map<string, PendingEntry>,
  base: string,
  requestPath: string,
  headers: Headers,
  ctrl: AbortController
): Promise<void> {
  try {
    void startReader();

    const body = JSON.stringify({ id: requestId, tool, params: params ?? {} });
    const res = await fetch(base + requestPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...Object.fromEntries(headers.entries()),
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const callPath = (process.env['MCP_SSE_CALL_PATH'] as string | undefined) ?? '';
      if (callPath) {
        const fallback = await fetch(base + callPath, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...Object.fromEntries(headers.entries()),
          },
          body: JSON.stringify({ tool, params: params ?? {} }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        pending.delete(requestId);
        if (!fallback.ok) return resolve({ error: `HTTP ${fallback.status}` });
        const json = await fallback.json().catch(() => null);
        return resolve(json ?? { ok: true });
      }
      clearTimeout(timer);
      pending.delete(requestId);
      return resolve({ error: `HTTP ${res.status}` });
    }
  } catch (err) {
    clearTimeout(timer);
    pending.delete(requestId);
    return resolve({ error: err instanceof Error ? err.message : String(err) });
  }
}

function createSseClient(server: Extract<McpServer, { transport: 'sse' }>): McpClient {
  // Real SSE client with request/response correlation via requestId
  const ctrl = new AbortController();
  const headers = new Headers();
  for (const [k, v] of Object.entries(server.headers ?? {})) headers.set(k, v);

  // Derive base from url that may end with '/sse' or '/events'
  const base = server.url.replace(/\/?(?:sse|events)$/, '');
  const eventsPath = (process.env['MCP_SSE_EVENTS_PATH'] as string | undefined) ?? '/sse';
  const requestPath = (process.env['MCP_SSE_REQUEST_PATH'] as string | undefined) ?? '/request';
  const timeoutMs = Number(process.env['MCP_SSE_CALL_TIMEOUT_MS'] ?? '20000');

  const pending: Map<string, PendingEntry> = new Map();

  let readerActive = false;

  async function processEventStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder
  ): Promise<void> {
    let buf = '';
    // Simple SSE frame parser: events separated by blank line
    // Aggregate 'data:' lines; extract 'event' and optional 'id'
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // Process complete events
      idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleSseFrame(frame);
        idx = buf.indexOf('\n\n');
      }
    }
  }

  async function startReader(): Promise<void> {
    if (readerActive) return;
    readerActive = true;
    try {
      const res = await fetch(base + eventsPath, {
        method: 'GET',
        headers,
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      await processEventStream(reader, decoder);
    } catch {
      // ignore connection failures; pending calls will timeout
    } finally {
      readerActive = false;
    }
  }

  function handleSseFrame(frame: string): void {
    const { eventName, id, payload } = parseSseFrame(frame);
    handleToolResult(eventName, payload, id, pending);
  }

  void startReader();

  return {
    name: server.name,
    transport: 'sse',
    dispose: async () => {
      try {
        ctrl.abort();
      } catch {}
      // Fail any pending calls
      for (const [key, p] of pending.entries()) {
        clearTimeout(p.timer);
        p.reject(new Error('disposed'));
        pending.delete(key);
      }
    },
    async callTool(
      tool: string,
      params?: Record<string, unknown>,
      opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
    ): Promise<unknown> {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({ error: 'timeout' });
        }, timeoutMs);
        const entry: PendingEntry = { resolve, reject, timer };
        if (opts && typeof opts.onProgress === 'function') entry.onProgress = opts.onProgress;
        pending.set(requestId, entry);

        // Handle the async fetch operation
        void handleSseRequest(
          requestId,
          tool,
          params,
          timer,
          resolve,
          startReader,
          pending,
          base,
          requestPath,
          headers,
          ctrl
        );
      });
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

export async function callTool(
  tool: string,
  params?: Record<string, unknown>,
  opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
): Promise<unknown> {
  // Tool name prefix convention: '<client>.<tool>' e.g., 'filesystem.list'
  const clientName = tool.includes('.') ? tool.slice(0, tool.indexOf('.')) : tool;
  const client = clients.get(clientName) || clients.get(clientName.toLowerCase());
  if (!client) throw new Error(`No MCP client registered for '${clientName}'`);
  return client.callTool(tool, params, opts);
}
