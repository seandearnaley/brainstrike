import { webTools } from '@brainstrike/agent';
import type { ToolCallStreamController } from 'assistant-stream';

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

export function handleToolStart(
  ctrl: StreamController,
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

export function handleToolProgress(
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

export function handleToolEnd(
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

export async function processAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>
): Promise<void> {
  let started = false;
  const tools = new Map<string, ToolCallStreamController>();

  for await (const chunk of agentStream) {
    if (chunk.type === 'finish' || chunk.type === 'message-finish') {
      ctrl.enqueue(toMessageFinishChunk(chunk));
      break;
    }
    if (chunk.type === 'text-delta') {
      started = handleTextDelta(ctrl, chunk.value, started);
    } else if (chunk.type === 'tool-event') {
      handleToolEvent(ctrl, tools, chunk);
    }
  }

  // Close any open tool parts
  for (const [, t] of tools) t.close();
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
  const { toAiSdkStyleStream } = await import('@brainstrike/agent');
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const data = body?.data ?? undefined;

  const stream = await toAiSdkStyleStream(messages, {
    ...(data ?? {}),
    mastraTools: webTools,
  });

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
  const { createAssistantStreamResponse } = await import('assistant-stream');
  const { toAiSdkStyleStream } = await import('@brainstrike/agent');

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const data = body?.data ?? undefined;
  const agentStream = await toAiSdkStyleStream(messages, {
    ...(data ?? {}),
    mastraTools: webTools,
  });

  const response = createAssistantStreamResponse(async (ctrl) => {
    await processAgentStream(ctrl as StreamController, agentStream as AsyncIterable<StreamChunk>);
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
