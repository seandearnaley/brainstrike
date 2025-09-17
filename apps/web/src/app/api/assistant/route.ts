import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { toAiSdkStyleStream, webTools } from '@brainstrike/agent';
import { createAssistantStreamResponse } from 'assistant-stream';
import {
  type StreamChunk,
  type StreamController,
  processAgentStream as streamAssistantMessages,
} from '../../../assistant-stream-helpers';

interface MessageContent {
  text?: string;
  content?: string | Array<{ text?: string; value?: string }>;
  role?: string;
  id?: string;
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

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const rawMessages = Array.isArray((body as Record<string, unknown>)['messages'])
    ? ((body as Record<string, unknown>)['messages'] as MessageContent[])
    : [];
  const data = (body as Record<string, unknown>)['data'] as RuntimeData | undefined;
  const agentMessages = toAgentMessages(rawMessages);

  return createAssistantStreamResponse(async (ctrl) => {
    // Ensure an assistant message container is present immediately on request
    // so tests can observe the label without waiting for the first delta.
    ctrl.addTextPart();
    const stream = await toAiSdkStyleStream(agentMessages, {
      ...(data ?? {}),
      mastraTools: webTools,
    });
    await streamAssistantMessages(ctrl as StreamController, stream as AsyncIterable<StreamChunk>);
  });
}
