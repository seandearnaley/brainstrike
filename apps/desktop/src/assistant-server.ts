import http from 'node:http';
import {
  clearToolRegistry,
  completeToolCall,
  convertAssistantUiMessages,
  createToolRegistry,
  recordToolProgress,
  startToolCall,
} from '@brainstrike/agent';
import { readOpenAIApiKey } from './openai-api-key';

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

type ToolControllerEntry = {
  controller: ToolCallStreamController;
  name: string;
};

type AssistantToolRegistry = {
  byKey: Map<string, ToolControllerEntry>;
  nameToKeys: Map<string, string[]>;
};

const createAssistantToolRegistry = createToolRegistry as unknown as () => AssistantToolRegistry;
const startToolProxy = startToolCall as unknown as (
  registry: AssistantToolRegistry,
  name: string,
  payload: unknown,
  controller: ToolCallStreamController
) => void;
const recordToolProgressProxy = recordToolProgress as unknown as (
  registry: AssistantToolRegistry,
  name: string,
  payload: unknown
) => string | undefined;
const completeToolProxy = completeToolCall as unknown as (
  registry: AssistantToolRegistry,
  name: string,
  status: string,
  payload: unknown
) => void;
const clearToolProxy = clearToolRegistry as unknown as (registry: AssistantToolRegistry) => void;

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
  registry: AssistantToolRegistry,
  chunk: StreamChunk
): string | undefined {
  const { name, status, payload } = chunk;
  if (!name || !status) return undefined;

  if (status === 'start') {
    const controller = ctrl.addToolCallPart({ toolName: name });
    startToolProxy(registry, name, payload, controller);
  } else if (status === 'progress') {
    return recordToolProgressProxy(registry, name, payload);
  } else if (status === 'success' || status === 'error') {
    completeToolProxy(registry, name, status, payload);
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
  const tools = createAssistantToolRegistry();
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
    for (const entry of tools.byKey.values()) {
      try {
        entry.controller.close();
      } catch {}
    }
    try {
      clearToolProxy(tools);
    } catch {}
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
  tools: AssistantToolRegistry,
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
  tools: AssistantToolRegistry,
  isAborted: () => boolean,
  setStarted: (started: boolean) => void,
  startedInitial: boolean
): Promise<void> {
  let started = startedInitial;
  for await (const chunk of agentStream) {
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
  const url = req.url ?? '';
  if (req.method === 'GET' && (url.endsWith('/assistant/status') || url === '/status')) {
    await handleAssistantStatus(res);
    return;
  }

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
  const apiKey = await readOpenAIApiKey();
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

async function handleAssistantStatus(res: http.ServerResponse): Promise<void> {
  try {
    const apiKey = await readOpenAIApiKey();
    const enabled = Boolean(apiKey);
    const payload = enabled ? { enabled } : { enabled, reason: 'missing_api_key' };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'assistant_status_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

function hasNonEmptyPrompt(messages: AgentMessage[]): boolean {
  const lastUser = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastText =
    lastUser?.parts.find((part: AgentMessage['parts'][number]) => part.type === 'text')?.text ?? '';
  return Boolean(lastText && lastText.trim().length > 0);
}

// Internal-only test surface to validate streaming glue behavior.
// Not part of the public API.
export const __assistantServerTest = {
  processAgentStream,
  toMessageFinishChunk,
};
