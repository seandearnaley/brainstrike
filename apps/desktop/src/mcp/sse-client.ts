import { generateUUID } from '@brainstrike/utils/crypto';
import type { McpServer } from '../mcp-loader';
import type { McpClient, PendingEntry } from './types';

function parseSseFrame(frame: string): { eventName: string; id?: string; payload: unknown } {
  const lines = frame.split(/\r?\n/);
  let eventName = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
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
  } catch {}
  const result: { eventName: string; id?: string; payload: unknown } = { eventName, payload };
  if (typeof id === 'string') {
    result.id = id;
  }
  return result;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

function extractKey(payload: unknown, fallbackId?: string): string | undefined {
  if (isObject(payload) && typeof payload['id'] === 'string' && payload['id']) {
    return payload['id'] as string;
  }
  return fallbackId;
}

function resolvePendingRequest(
  key: string,
  eventName: string,
  obj: { id?: string; ok?: boolean; result?: unknown; error?: unknown },
  pending: Map<string, PendingEntry>
): void {
  const p = pending.get(key);
  if (!p) {
    return;
  }
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

function resolveAllPendingWithError(pending: Map<string, PendingEntry>, error: unknown): void {
  for (const [pendingKey, entry] of pending.entries()) {
    clearTimeout(entry.timer);
    entry.resolve({ error });
    pending.delete(pendingKey);
  }
}

function handleToolResultOrError(
  eventName: 'tool-result' | 'tool-error',
  payload: unknown,
  id: string | undefined,
  pending: Map<string, PendingEntry>
): void {
  if (!isObject(payload)) {
    return;
  }
  const obj = payload as { id?: string; ok?: boolean; result?: unknown; error?: unknown };
  const key = extractKey(obj, id);
  if (key && pending.has(key)) {
    resolvePendingRequest(key, eventName, obj, pending);
    return;
  }
  if (eventName === 'tool-error') {
    resolveAllPendingWithError(pending, obj.error ?? 'error');
  }
}

function handleToolProgressEvent(
  payload: unknown,
  id: string | undefined,
  pending: Map<string, PendingEntry>
): void {
  if (!isObject(payload)) {
    return;
  }
  const obj = payload as { id?: string; [k: string]: unknown };
  const key = extractKey(obj, id);
  if (!key) {
    return;
  }
  const entry = pending.get(key);
  if (entry?.onProgress) {
    entry.onProgress(payload, { id: key });
  }
}

function handleToolResult(
  eventName: string,
  payload: unknown,
  id: string | undefined,
  pending: Map<string, PendingEntry>
): void {
  switch (eventName) {
    case 'tool-result':
    case 'tool-error':
      handleToolResultOrError(eventName, payload, id, pending);
      break;
    case 'tool-progress':
      handleToolProgressEvent(payload, id, pending);
      break;
    default:
      break;
  }
}

async function handleSseRequest(
  requestId: string,
  tool: string,
  params: Record<string, unknown> | undefined,
  timer: NodeJS.Timeout,
  resolve: (v: unknown) => void,
  startReader: () => Promise<void>,
  pending: Map<string, PendingEntry>,
  base: string,
  callPath: string,
  headers: Headers,
  ctrl: AbortController
): Promise<void> {
  try {
    // Start the SSE reader without blocking the request lifecycle
    void startReader();
    const res = await fetch(base + callPath, {
      body: JSON.stringify({ id: requestId, params: params ?? {}, tool }),
      headers,
      method: 'POST',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const fallbackPath = (process.env['MCP_SSE_CALL_PATH'] as string | undefined) ?? '';
      if (fallbackPath) {
        const fallback = await fetch(base + fallbackPath, {
          body: JSON.stringify({ params: params ?? {}, tool }),
          headers: { 'Content-Type': 'application/json', ...Object.fromEntries(headers.entries()) },
          method: 'POST',
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        pending.delete(requestId);
        if (!fallback.ok) {
          return resolve({ error: `HTTP ${fallback.status}` });
        }
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

export function createSseClient(server: Extract<McpServer, { transport: 'sse' }>): McpClient {
  const ctrl = new AbortController();
  const headers = new Headers();
  for (const [k, v] of Object.entries(server.headers ?? {})) {
    headers.set(k, v);
  }
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
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const { eventName, id, payload } = parseSseFrame(frame);
        handleToolResult(eventName, payload, id, pending);
        idx = buf.indexOf('\n\n');
      }
    }
  }

  async function startReader(): Promise<void> {
    if (readerActive) {
      return;
    }
    readerActive = true;
    try {
      const res = await fetch(base + eventsPath, { headers, method: 'GET', signal: ctrl.signal });
      if (!(res.ok && res.body)) {
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      await processEventStream(reader, decoder);
    } catch {
    } finally {
      readerActive = false;
    }
  }

  // Establish SSE reader eagerly to avoid missing early server events
  void startReader();

  return {
    async callTool(
      tool: string,
      params?: Record<string, unknown>,
      opts?: { onProgress?: (payload: unknown, meta?: { id?: string }) => void }
    ): Promise<unknown> {
      const requestId = generateUUID();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({ error: 'timeout' });
        }, timeoutMs);
        const entry: PendingEntry = { reject, resolve, timer };
        if (opts && typeof opts.onProgress === 'function') {
          entry.onProgress = opts.onProgress;
        }
        pending.set(requestId, entry);
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
    dispose: async () => {
      try {
        ctrl.abort();
      } catch {}
      for (const [key, p] of pending.entries()) {
        clearTimeout(p.timer);
        p.reject(new Error('disposed'));
        pending.delete(key);
      }
    },
    async listTools(): Promise<Record<string, never>> {
      throw new Error(`MCP SSE tool discovery is not implemented for server '${server.name}'.`);
    },
    name: server.name,
    supportsTool(toolId: string): boolean {
      return toolId.startsWith(`${server.name}.`);
    },
    transport: 'sse',
  } satisfies McpClient;
}
