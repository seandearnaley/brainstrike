import http from 'node:http';
import { createAssistantStreamResponse, type ToolCallStreamController } from 'assistant-stream';
import type { McpConfig } from './mcp-loader';
import { loadMcpConfig } from './mcp-loader';

interface MessageContent {
  text?: string;
  content?: string | Array<{ text?: string; value?: string }>;
  role?: string;
  id?: string;
}

type AgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: 'text'; text: string }>;
};
type RuntimeData = {
  projectId?: string;
  provider?: string;
  model?: string;
  mcpEnabled?: boolean;
  mcpConfig?: McpConfig;
};

function pickUserText(msg: MessageContent | undefined): string | null {
  if (!msg || msg.role !== 'user') return null;
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = c
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p.text === 'string') return p.text;
        if (typeof p.value === 'string') return p.value;
        return '';
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
  }
  if (typeof msg.text === 'string') return msg.text;
  return null;
}

function toAgentMessages(rawMessages: MessageContent[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of rawMessages) {
    if (!m) continue;
    const t = pickUserText(m);
    if (t && m.role === 'user') {
      out.push({
        id: String(m.id ?? crypto.randomUUID()),
        role: 'user',
        parts: [{ type: 'text', text: t }],
      });
    }
  }
  if (out.length === 0 && rawMessages.length > 0) {
    const last = rawMessages[rawMessages.length - 1];
    const t = pickUserText(last);
    if (t) {
      if (!last) return out;
      out.push({
        id: String((last as MessageContent).id ?? crypto.randomUUID()),
        role: 'user',
        parts: [{ type: 'text', text: t }],
      });
    }
  }
  return out;
}

// removed legacy toCoreMessages helper – not used with assistant-stream path

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  await new Promise<void>((resolve) => req.on('end', () => resolve()));
  return body;
}

function handleToolStart(
  ctrl: {
    addTextPart: () => void;
    addToolCallPart: (options: { toolName: string }) => ToolCallStreamController;
  },
  tools: Map<string, ToolCallStreamController>,
  name: string,
  payload: unknown
): void {
  const t = ctrl.addToolCallPart({ toolName: name });
  if (payload) {
    try {
      t.argsText.append(JSON.stringify(payload, null, 2));
    } catch {
      t.argsText.append(String(payload));
    }
  }
  tools.set(name, t);
}

function handleToolProgress(
  tools: Map<string, ToolCallStreamController>,
  name: string,
  payload: unknown
): void {
  const t = tools.get(name);
  if (t && payload) {
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
    t.argsText.append(`\n${line}`);
  }
}

function handleToolEnd(
  tools: Map<string, ToolCallStreamController>,
  name: string,
  status: string,
  payload: unknown
): void {
  const t = tools.get(name);
  if (t) {
    t.setResponse({
      result: payload ? JSON.parse(JSON.stringify(payload)) : null,
      isError: status === 'error',
    });
    t.close();
    tools.delete(name);
  }
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
  tools: Map<string, ToolCallStreamController>,
  chunk: StreamChunk
): void {
  const { name, status, payload } = chunk;
  if (!name || !status) return;

  if (status === 'start') {
    handleToolStart(ctrl, tools, name, payload);
  } else if (status === 'progress') {
    handleToolProgress(tools, name, payload);
  } else if (status === 'success' || status === 'error') {
    handleToolEnd(tools, name, status, payload);
  }
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
  const tools = new Map<string, ToolCallStreamController>();
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
    for (const [, t] of tools) t.close();
    try {
      ctrl.close();
    } catch {}
    if (signal) signal.removeEventListener?.('abort', onAbort as EventListener);
  }
}

async function iterateAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>,
  tools: Map<string, ToolCallStreamController>,
  isAborted: () => boolean,
  setStarted: (started: boolean) => void,
  startedInitial: boolean
): Promise<void> {
  let started = startedInitial;
  for await (const chunk of agentStream) {
    console.info('[assistant-server] stream chunk', chunk);
    if (chunk.type === 'finish' || chunk.type === 'message-finish') {
      ctrl.enqueue(toMessageFinishChunk(chunk));
      setStarted(false);
      break;
    }
    if (isAborted()) break;
    if (chunk.type === 'text-delta') {
      const nextStarted = handleTextDelta(ctrl, chunk.value, started);
      started = nextStarted;
      setStarted(nextStarted);
    } else if (chunk.type === 'tool-event') {
      handleToolEvent(ctrl, tools, chunk);
    }
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
  const rawMessages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const data: RuntimeData | undefined = parsed?.data ?? undefined;
  const apiKey = await readOpenAIApiKeySafe();
  const messages = toAgentMessages(rawMessages);
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
  const response = createAssistantStreamResponse(async (ctrl) => {
    const abortController = new AbortController();
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
    const mcpConfig = (await loadMcpConfig()).config;
    const agentStream = await mod.toAiSdkStyleStream(messages, {
      ...data,
      mcpEnabled: true,
      ...(apiKey ? { apiKey } : {}),
      signal: abortController.signal,
      mcpConfig,
      mastraTools: mod.webTools,
    });
    console.info('[assistant-server] stream initialized');

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
  const lastText = lastUser?.parts.find((p) => p.type === 'text')?.text ?? '';
  return Boolean(lastText && lastText.trim().length > 0);
}
