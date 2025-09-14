import type { ToolCallStreamController } from 'assistant-stream';

export interface StreamChunk {
  type: 'text-delta' | 'tool-event';
  value?: string;
  name?: string;
  status?: string;
  payload?: unknown;
}

export interface StreamController {
  addTextPart: () => void;
  appendText: (text: string) => void;
  addToolCallPart: (options: { toolName: string }) => ToolCallStreamController;
  close: () => void;
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

export async function processAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>
): Promise<void> {
  let started = false;
  const tools = new Map<string, ToolCallStreamController>();

  for await (const chunk of agentStream) {
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
  const stream = await toAiSdkStyleStream(messages, data);

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  for await (const chunk of stream) {
    res.write(`${JSON.stringify(chunk)}\n`);
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
  const agentStream = await toAiSdkStyleStream(messages, data);

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
