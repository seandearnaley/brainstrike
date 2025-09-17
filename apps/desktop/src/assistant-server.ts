import http from 'node:http';
import { convertAssistantUiMessages } from '@brainstrike/agent';

type AgentModule = typeof import('@brainstrike/agent');
type AgentMessage = AgentModule['AgentMessage'];
type AssistantUiMessage = AgentModule['AssistantUiMessage'];
type RuntimeData = AgentModule['RuntimeData'];

import { createAssistantStreamResponse, type ToolCallStreamController } from 'assistant-stream';
import { loadMcpConfig } from './mcp-loader';

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  await new Promise<void>((resolve) => req.on('end', () => resolve()));
  return body;
}

type ToolRegistryEntry = {
  controller: ToolCallStreamController;
  name: string;
};

type ToolRegistry = {
  byKey: Map<string, ToolRegistryEntry>;
  nameToKeys: Map<string, string[]>;
};

let toolKeyCounter = 0;

function createToolRegistry(): ToolRegistry {
  return { byKey: new Map(), nameToKeys: new Map() };
}

function extractCallId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const candidates = [record['callId'], record['toolCallId'], record['id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  const call = record['call'];
  if (call && typeof call === 'object') {
    const nestedId = (call as Record<string, unknown>)['id'];
    if (typeof nestedId === 'string' && nestedId.trim().length > 0) {
      return nestedId;
    }
  }
  return undefined;
}

function nextSyntheticToolKey(name: string): string {
  toolKeyCounter += 1;
  return `${name}#${Date.now()}#${toolKeyCounter}`;
}

function registerToolController(
  registry: ToolRegistry,
  key: string,
  name: string,
  controller: ToolCallStreamController
): void {
  registry.byKey.set(key, { controller, name });
  const queue = registry.nameToKeys.get(name) ?? [];
  queue.push(key);
  registry.nameToKeys.set(name, queue);
}

function resolveToolKey(
  registry: ToolRegistry,
  name: string,
  payload: unknown
): string | undefined {
  const callId = extractCallId(payload);
  if (callId && registry.byKey.has(callId)) {
    return callId;
  }
  const queue = registry.nameToKeys.get(name);
  if (!queue || queue.length === 0) {
    return undefined;
  }
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const candidate = queue[i];
    if (typeof candidate === 'string' && registry.byKey.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveToolEntry(
  registry: ToolRegistry,
  name: string,
  payload: unknown
): [string, ToolRegistryEntry] | undefined {
  const key = resolveToolKey(registry, name, payload);
  if (!key) return undefined;
  const entry = registry.byKey.get(key);
  if (!entry) return undefined;
  return [key, entry];
}

function releaseToolEntry(registry: ToolRegistry, key: string): ToolRegistryEntry | undefined {
  const entry = registry.byKey.get(key);
  if (!entry) return undefined;
  registry.byKey.delete(key);
  const queue = registry.nameToKeys.get(entry.name);
  if (queue) {
    const idx = queue.lastIndexOf(key);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) {
      registry.nameToKeys.delete(entry.name);
    }
  }
  return entry;
}

function handleToolStart(
  ctrl: StreamController,
  registry: ToolRegistry,
  name: string,
  payload: unknown
): void {
  const key = extractCallId(payload) ?? nextSyntheticToolKey(name);
  const controller = ctrl.addToolCallPart({ toolName: name });
  if (payload) {
    try {
      controller.argsText.append(JSON.stringify(payload, null, 2));
    } catch {
      controller.argsText.append(String(payload));
    }
  }
  registerToolController(registry, key, name, controller);
}

function handleToolProgress(
  registry: ToolRegistry,
  name: string,
  payload: unknown
): string | undefined {
  const resolved = resolveToolEntry(registry, name, payload);
  if (!resolved) return undefined;
  const [, entry] = resolved;
  if (!payload) return undefined;
  const p = payload as Record<string, unknown>;
  const step = typeof p['step'] === 'string' ? (p['step'] as string) : undefined;
  const percent = typeof p['percent'] === 'number' ? (p['percent'] as number) : undefined;
  const note = typeof p['note'] === 'string' ? (p['note'] as string) : undefined;
  const line = [
    step ?? 'Progress',
    typeof percent === 'number' ? `(${Math.round(percent)}%)` : null,
    note ? `— ${note}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  entry.controller.argsText.append(`\n${line}`);
  return line;
}

function handleToolEnd(
  registry: ToolRegistry,
  name: string,
  status: string,
  payload: unknown
): void {
  const resolved = resolveToolEntry(registry, name, payload);
  if (!resolved) return;
  const [key, entry] = resolved;
  entry.controller.setResponse({
    result: payload ? JSON.parse(JSON.stringify(payload)) : null,
    isError: status === 'error',
  });
  entry.controller.close();
  releaseToolEntry(registry, key);
}

interface StreamChunk {
  type: 'text-delta' | 'tool-event' | 'finish' | 'message-finish';
  value?: string;
  name?: string;
  status?: string;
  payload?: unknown;
  usage?: { promptTokens?: number; completionTokens?: number };
  finishReason?: string;
  path?: ReadonlyArray<number>;
}

interface StreamController {
  addTextPart: () => void;
  appendText: (text: string) => void;
  addToolCallPart: (options: { toolName: string }) => ToolCallStreamController;
  close: () => void;
  enqueue: (chunk: {
    type: 'message-finish';
    finishReason: 'stop';
    usage: { promptTokens: number; completionTokens: number };
    path: ReadonlyArray<number>;
  }) => void;
}

function handleTextDelta(ctrl: StreamController, value?: string, startedParam?: boolean): boolean {
  let started = startedParam;
  if (!started) {
    ctrl.addTextPart();
    started = true;
  }
  if (value) {
    ctrl.appendText(value);
  }
  return started;
}

function handleToolEvent(
  ctrl: StreamController,
  registry: ToolRegistry,
  chunk: StreamChunk
): string | undefined {
  const { name, status, payload } = chunk;
  if (!name || !status) return;

  if (status === 'start') {
    handleToolStart(ctrl, registry, name, payload);
  } else if (status === 'progress') {
    return handleToolProgress(registry, name, payload);
  } else if (status === 'success' || status === 'error') {
    handleToolEnd(registry, name, status, payload);
  }
  return undefined;
}

function toMessageFinishChunk(chunk: StreamChunk): {
  type: 'message-finish';
  finishReason: 'stop';
  usage: { promptTokens: number; completionTokens: number };
  path: ReadonlyArray<number>;
} {
  const usage = chunk.usage ?? { promptTokens: 0, completionTokens: 0 };
  const promptTokensRaw = usage.promptTokens;
  const completionTokensRaw = usage.completionTokens;
  const promptTokens =
    typeof promptTokensRaw === 'number' && Number.isFinite(promptTokensRaw) ? promptTokensRaw : 0;
  const completionTokens =
    typeof completionTokensRaw === 'number' && Number.isFinite(completionTokensRaw)
      ? completionTokensRaw
      : 0;

  return {
    type: 'message-finish',
    finishReason: 'stop',
    usage: { promptTokens, completionTokens },
    path: Array.isArray(chunk.path) ? chunk.path : [],
  };
}

async function processAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>,
  signal?: AbortSignal | null,
  preStarted?: boolean
): Promise<void> {
  let started = Boolean(preStarted);
  const tools = createToolRegistry();
  let aborted = Boolean(signal?.aborted);
  const onAbort = () => {
    aborted = true;
  };
  try {
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    await iterateAgentStream(
      ctrl,
      agentStream,
      tools,
      () => aborted,
      (v) => {
        started = v;
      },
      started
    );
  } catch (err) {
    // If aborted, suppress errors from upstream cancellation
    if (!(aborted && err instanceof Error)) {
      // no-op; we purposely avoid surfacing provider errors here
    }
  } finally {
    const remaining = new Set<ToolCallStreamController>();
    for (const entry of tools.byKey.values()) {
      remaining.add(entry.controller);
    }
    for (const controller of remaining) {
      try {
        controller.close();
      } catch {}
    }
    try {
      ctrl.close();
    } catch {}
    if (signal) signal.removeEventListener?.('abort', onAbort as EventListener);
  }
}

type DesktopChunkResult = {
  started: boolean;
  finished: boolean;
};

function processDesktopChunk(
  ctrl: StreamController,
  tools: ToolRegistry,
  chunk: StreamChunk,
  started: boolean,
  setStarted: (started: boolean) => void
): DesktopChunkResult {
  if (chunk.type === 'finish' || chunk.type === 'message-finish') {
    ctrl.enqueue(toMessageFinishChunk(chunk));
    setStarted(false);
    return { started, finished: true };
  }

  if (chunk.type === 'text-delta') {
    const nextStarted = handleTextDelta(ctrl, chunk.value, started);
    setStarted(nextStarted);
    return { started: nextStarted, finished: false };
  }

  if (chunk.type === 'tool-event') {
    const progressText = handleToolEvent(ctrl, tools, chunk);
    const nextStarted = progressText ? handleTextDelta(ctrl, `${progressText}\n`, false) : started;
    setStarted(nextStarted);
    return { started: nextStarted, finished: false };
  }

  return { started, finished: false };
}

async function iterateAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>,
  tools: ToolRegistry,
  isAborted: () => boolean,
  setStarted: (started: boolean) => void,
  startedInitial: boolean
): Promise<void> {
  let started = startedInitial;
  for await (const chunk of agentStream) {
    console.info('[assistant-server] stream chunk', chunk);
    if (chunk.type === 'tool-event' && !started && chunk.status === 'start') {
      ctrl.addTextPart();
      started = true;
      setStarted(true);
    }
    if (isAborted()) break;
    const result = processDesktopChunk(ctrl, tools, chunk, started, setStarted);
    started = result.started;
    if (result.finished) break;
  }
}

async function streamResponse(
  res: http.ServerResponse,
  response: { status: number; headers: Headers; body: ReadableStream | null },
  signal?: AbortSignal | null
): Promise<void> {
  writeHeaders(res, response.headers);
  // Ensure the connection closes at end of stream so the client settles
  try {
    res.setHeader('Connection', 'close');
  } catch {}
  res.writeHead(response.status);

  const body = response.body as unknown as ReadableStream<Uint8Array> | null;
  if (!body) {
    res.end();
    return;
  }

  await pumpReadableToResponse(body, res, signal);
}

function writeHeaders(res: http.ServerResponse, headers: Headers): void {
  for (const [k, v] of headers.entries()) {
    try {
      res.setHeader(k, v);
    } catch {}
  }
}

async function pumpReadableToResponse(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  signal?: AbortSignal | null
): Promise<void> {
  const reader = (
    body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }
  ).getReader();
  let aborted = Boolean(signal?.aborted);
  const onAbort = () => {
    aborted = true;
    try {
      res.end();
    } catch {}
  };
  try {
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted) break;
      if (value && value.length > 0) res.write(value);
    }
  } catch {
    // ignore
  } finally {
    try {
      res.end();
    } catch {}
    if (signal) signal.removeEventListener?.('abort', onAbort as EventListener);
  }
}

export function startAssistantServer(portHint?: number) {
  const server = http.createServer(async (req, res) => {
    await handleAssistantRequest(req, res).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'assistant server error' }));
    });
  });

  const port = Number(process.env['BS_ASSISTANT_PORT'] ?? portHint ?? 0) || 0;
  return new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        url,
        stop: async () => await new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function handleAssistantRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method !== 'POST' || !(req.url?.endsWith('/assistant') || req.url === '/')) {
    res.writeHead(404).end('not found');
    return;
  }

  const body = await readRequestBody(req);
  const parsed = JSON.parse(body || '{}');
  const rawMessages = Array.isArray(parsed?.messages)
    ? (parsed.messages as AssistantUiMessage[])
    : [];
  const data: RuntimeData | undefined = parsed?.data ?? undefined;
  const apiKey = await readOpenAIApiKeySafe();
  const messages = convertAssistantUiMessages(rawMessages);
  console.info('[assistant-server] request received', {
    messageCount: messages.length,
    hasApiKey: Boolean(apiKey),
  });

  if (!hasNonEmptyPrompt(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'empty_prompt' }));
    return;
  }

  const mod = await import('@brainstrike/agent');
  const abortController = new AbortController();
  const mcpConfig = (await loadMcpConfig()).config;
  let agentStream: AsyncIterable<StreamChunk>;
  try {
    agentStream = await mod.toAiSdkStyleStream(messages, {
      ...data,
      mcpEnabled: true,
      ...(apiKey ? { apiKey } : {}),
      signal: abortController.signal,
      mcpConfig,
      mastraTools: mod.webTools,
    });
    console.info('[assistant-server] stream initialized');
  } catch (error) {
    console.error('[assistant-server] failed to initialize assistant stream', error);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  const response = createAssistantStreamResponse(async (ctrl) => {
    const abort = () => abortController.abort();
    req.on('close', abort);
    req.on('aborted', abort);
    abortController.signal.addEventListener(
      'abort',
      () => {
        try {
          ctrl.close();
        } catch {}
      },
      { once: true }
    );
    await processAgentStream(ctrl, agentStream, abortController.signal, false);
  });

  await streamResponse(res, response, undefined);
}

async function readOpenAIApiKeySafe(): Promise<string | undefined> {
  try {
    const { getSecretsService } = await import('./secrets');
    const svc = getSecretsService();
    return (await svc.getKey('openai')) || undefined;
  } catch {
    return undefined;
  }
}

function hasNonEmptyPrompt(messages: AgentMessage[]): boolean {
  const lastUser = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastText =
    lastUser?.parts.find((part: AgentMessage['parts'][number]) => part.type === 'text')?.text ?? '';
  return Boolean(lastText && lastText.trim().length > 0);
}
