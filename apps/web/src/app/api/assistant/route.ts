import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { toAiSdkStyleStream, webTools } from '@brainstrike/agent';
import type { ToolCallStreamController } from 'assistant-stream';
import { createAssistantStreamResponse } from 'assistant-stream';

interface MessageContent {
  text?: string;
  content?: string | Array<{ text?: string; value?: string }>;
  role?: string;
  id?: string;
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

function pickUserText(msg: MessageContent): string | null {
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
  // Fallback: if nothing parsed but last item has string content, treat it as user
  if (out.length === 0 && rawMessages.length > 0) {
    const last = rawMessages[rawMessages.length - 1];
    if (!last) return out;
    const t = pickUserText(last);
    if (t)
      out.push({
        id: String(last.id ?? crypto.randomUUID()),
        role: 'user',
        parts: [{ type: 'text', text: t }],
      });
  }
  return out;
}

function handleToolStart(
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

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const rawMessages = Array.isArray((body as Record<string, unknown>)['messages'])
    ? ((body as Record<string, unknown>)['messages'] as MessageContent[])
    : [];
  const data = (body as Record<string, unknown>)['data'] as RuntimeData | undefined;
  const agentMessages = toAgentMessages(rawMessages);

  return createAssistantStreamResponse(async (ctrl) => {
    const stream = await toAiSdkStyleStream(agentMessages, {
      ...(data ?? {}),
      mastraTools: webTools,
    });
    await processAgentStream(ctrl as StreamController, stream as AsyncIterable<StreamChunk>);
  });
}
