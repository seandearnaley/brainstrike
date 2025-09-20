import {
  type StreamChunk as AgentStreamChunk,
  type AssistantUiMessage,
  clearToolRegistry,
  completeToolCall,
  convertAssistantUiMessages,
  createToolRegistry,
  recordToolProgress,
  type StreamChunkFinish,
  type StreamChunkMessageFinish,
  sanitizeStreamChunk,
  startToolCall,
  type ToolCallControllerLike,
  type ToolRegistry,
  webTools,
} from '@brainstrike/agent';
import type { ToolCallStreamController } from 'assistant-stream';
import { createAssistantStreamResponse } from 'assistant-stream';
import type { AssistantProviderConfig } from './server/assistant-config';
import { resolveAssistantProviderConfig } from './server/assistant-config';

export type StreamChunk = AgentStreamChunk;

type TextStreamChunk = Extract<StreamChunk, { type: 'text-delta' }>;
type ToolEventStreamChunk = Extract<StreamChunk, { type: 'tool-event' }>;
type FinishStreamChunk = StreamChunkFinish | StreamChunkMessageFinish;

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

type AssistantToolRegistry = ToolRegistry<ToolCallControllerLike>;

export function handleToolStart(
  ctrl: StreamController,
  tools: AssistantToolRegistry,
  name: string,
  payload: unknown
): void {
  const controller = ctrl.addToolCallPart({ toolName: name });
  startToolCall(tools, name, payload, controller as unknown as ToolCallControllerLike);
}

export function handleToolProgress(
  tools: AssistantToolRegistry,
  name: string,
  payload: unknown
): string | undefined {
  return recordToolProgress(tools, name, payload);
}

export function handleToolEnd(
  tools: AssistantToolRegistry,
  name: string,
  status: string,
  payload: unknown
): void {
  completeToolCall(tools, name, status, payload);
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
  tools: AssistantToolRegistry,
  chunk: StreamChunk
): string | undefined {
  if (chunk.type !== 'tool-event') return undefined;
  const { name, status, payload } = chunk;

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

function toMessageFinishChunk(chunk: FinishStreamChunk): {
  type: 'message-finish';
  finishReason: 'stop';
  usage: { promptTokens: number; completionTokens: number };
  path: ReadonlyArray<number>;
} {
  const usage = chunk.usage;
  const promptTokensRaw = usage?.promptTokens;
  const completionTokensRaw = usage?.completionTokens;
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
    path: chunk.type === 'message-finish' ? chunk.path : [],
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
  chunk: TextStreamChunk,
  started: boolean
): ChunkProcessingResult {
  const nextStarted = handleTextDelta(ctrl, chunk.value, started);
  return { started: nextStarted, done: false };
}

function processToolChunk(
  ctrl: StreamController,
  tools: AssistantToolRegistry,
  chunk: ToolEventStreamChunk,
  started: boolean
): ChunkProcessingResult {
  const progressText = handleToolEvent(ctrl, tools, chunk);
  const nextStarted = progressText ? handleTextDelta(ctrl, `${progressText}\n`, false) : started;
  return { started: nextStarted, done: false };
}

function handleStreamChunk(
  ctrl: StreamController,
  tools: AssistantToolRegistry,
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
  const tools = createToolRegistry<ToolCallControllerLike>();

  for await (const chunk of agentStream) {
    const { started: nextStarted, done } = handleStreamChunk(ctrl, tools, chunk, started);
    started = nextStarted;
    if (done) break;
  }

  const remaining = new Set<ToolCallControllerLike>();
  for (const entry of tools.byKey.values()) {
    remaining.add(entry.controller);
  }
  for (const controller of remaining) {
    try {
      controller.close();
    } catch {}
  }
  try {
    clearToolRegistry(tools);
  } catch {}
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
    const safeChunk = sanitizeStreamChunk(chunk);
    res.write(`${JSON.stringify(safeChunk)}\n`);
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
