import { type AssistantUiMessage, convertAssistantUiMessages, webTools } from '@brainstrike/agent';
import type { ToolCallStreamController } from 'assistant-stream';
import { createAssistantStreamResponse } from 'assistant-stream';
import type { AssistantProviderConfig } from './server/assistant-config';
import { resolveAssistantProviderConfig } from './server/assistant-config';

export interface StreamChunk {
  type: 'text-delta' | 'tool-event' | 'finish' | 'message-finish';
  value?: string;
  name?: string;
  status?: string;
  payload?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
  path?: ReadonlyArray<number>;
}

export interface StreamController {
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

export function handleToolStart(
  ctrl: StreamController,
  tools: ToolRegistry,
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
  registerToolController(tools, key, name, controller);
}

export function handleToolProgress(
  tools: ToolRegistry,
  name: string,
  payload: unknown
): string | undefined {
  const resolved = resolveToolEntry(tools, name, payload);
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

export function handleToolEnd(
  tools: ToolRegistry,
  name: string,
  status: string,
  payload: unknown
): void {
  const resolved = resolveToolEntry(tools, name, payload);
  if (!resolved) return;
  const [key, entry] = resolved;
  entry.controller.setResponse({
    result: payload ? JSON.parse(JSON.stringify(payload)) : null,
    isError: status === 'error',
  });
  entry.controller.close();
  releaseToolEntry(tools, key);
}

export function handleTextDelta(
  ctrl: StreamController,
  value?: string,
  startedParam?: boolean
): boolean {
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

export function handleToolEvent(
  ctrl: StreamController,
  tools: ToolRegistry,
  chunk: StreamChunk
): string | undefined {
  const { name, status, payload } = chunk;
  if (!name || !status) return;

  if (status === 'start') {
    handleToolStart(ctrl, tools, name, payload);
  } else if (status === 'progress') {
    const line = handleToolProgress(tools, name, payload);
    return line;
  } else if (status === 'success' || status === 'error') {
    handleToolEnd(tools, name, status, payload);
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

type ChunkProcessingResult = { started: boolean; done: boolean };

function ensureAssistantMessage(
  ctrl: StreamController,
  started: boolean,
  chunk: StreamChunk
): boolean {
  if (!started && chunk.type === 'tool-event' && chunk.status === 'start') {
    ctrl.addTextPart();
    return true;
  }
  return started;
}

function processTextChunk(
  ctrl: StreamController,
  chunk: StreamChunk,
  started: boolean
): ChunkProcessingResult {
  const nextStarted = handleTextDelta(ctrl, chunk.value, started);
  return { started: nextStarted, done: false };
}

function processToolChunk(
  ctrl: StreamController,
  tools: ToolRegistry,
  chunk: StreamChunk,
  started: boolean
): ChunkProcessingResult {
  const progressText = handleToolEvent(ctrl, tools, chunk);
  const nextStarted = progressText ? handleTextDelta(ctrl, `${progressText}\n`, false) : started;
  return { started: nextStarted, done: false };
}

function handleStreamChunk(
  ctrl: StreamController,
  tools: ToolRegistry,
  chunk: StreamChunk,
  started: boolean
): ChunkProcessingResult {
  if (chunk.type === 'finish' || chunk.type === 'message-finish') {
    ctrl.enqueue(toMessageFinishChunk(chunk));
    return { started, done: true };
  }

  const ensuredStarted = ensureAssistantMessage(ctrl, started, chunk);
  if (chunk.type === 'text-delta') {
    return processTextChunk(ctrl, chunk, ensuredStarted);
  }
  if (chunk.type === 'tool-event') {
    return processToolChunk(ctrl, tools, chunk, ensuredStarted);
  }
  return { started: ensuredStarted, done: false };
}

export async function processAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>
): Promise<void> {
  let started = false;
  const tools = createToolRegistry();

  for await (const chunk of agentStream) {
    const { started: nextStarted, done } = handleStreamChunk(ctrl, tools, chunk, started);
    started = nextStarted;
    if (done) break;
  }

  const remaining = new Set<ToolCallStreamController>();
  for (const entry of tools.byKey.values()) {
    remaining.add(entry.controller);
  }
  for (const controller of remaining) {
    try {
      controller.close();
    } catch {}
  }
  ctrl.close();
}

export async function readBody(req: import('http').IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

export async function handleChatEndpoint(
  body: { messages?: unknown; data?: unknown },
  res: import('http').ServerResponse
): Promise<void> {
  const provider = resolveAssistantProviderConfig();
  if (!provider.enabled || !provider.apiKey) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  const { toAiSdkStyleStream } = await import('@brainstrike/agent');
  const rawMessages = Array.isArray(body?.messages) ? (body.messages as AssistantUiMessage[]) : [];
  const agentMessages = convertAssistantUiMessages(rawMessages);
  const data = body?.data ?? undefined;

  let stream: AsyncIterable<StreamChunk>;
  try {
    stream = await toAiSdkStyleStream(agentMessages, {
      ...(data ?? {}),
      mastraTools: webTools,
      apiKey: provider.apiKey,
    });
  } catch (error) {
    console.error('[web assistant] failed to initialize chat stream', error);
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        error: 'agent_stream_init_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  for await (const chunk of stream) {
    res.write(`${JSON.stringify(chunk)}\n`);
    // Small delay to ensure UI observes streaming state in E2E and dev
    // This avoids extremely fast streams completing before the UI can disable the Send button
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  res.end();
}

export async function handleAssistantEndpoint(
  body: { messages?: unknown; data?: unknown },
  res: import('http').ServerResponse
): Promise<void> {
  const provider = resolveAssistantProviderConfig();
  if (!provider.enabled || !provider.apiKey) {
    sendAssistantDisabledResponse(res, provider);
    return;
  }

  const { toAiSdkStyleStream } = await import('@brainstrike/agent');

  const rawMessages = Array.isArray(body?.messages) ? (body.messages as AssistantUiMessage[]) : [];
  const agentMessages = convertAssistantUiMessages(rawMessages);
  const data = body?.data ?? undefined;
  let agentStream: AsyncIterable<StreamChunk>;
  try {
    agentStream = await toAiSdkStyleStream(agentMessages, {
      ...(data ?? {}),
      mastraTools: webTools,
      apiKey: provider.apiKey,
    });
  } catch (error) {
    console.error('[web assistant] failed to initialize assistant stream', error);
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
    ctrl.addTextPart();
    await processAgentStream(ctrl as StreamController, agentStream);
  });

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const reader = (response.body as unknown as ReadableStream).getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }

  res.end();
}

function sendAssistantDisabledResponse(
  res: import('http').ServerResponse,
  provider: AssistantProviderConfig
): void {
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify({
      error: 'assistant_disabled',
      reason: assistantStatusPayload(provider).reason,
    })
  );
}

export function sendAssistantStatusResponse(res: import('http').ServerResponse): void {
  const provider = resolveAssistantProviderConfig();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(assistantStatusPayload(provider)));
}

function assistantStatusPayload(provider: AssistantProviderConfig): {
  enabled: boolean;
  reason?: string;
} {
  if (provider.enabled && provider.apiKey) {
    return { enabled: true };
  }
  return {
    enabled: false,
    reason: provider.disabledReason ?? 'missing_api_key',
  };
}
