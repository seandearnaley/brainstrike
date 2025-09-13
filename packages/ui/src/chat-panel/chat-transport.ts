import { generateUUID } from '@brainstrike/utils';

export type StreamChunkText = { type: 'text-delta'; value: string };
export type StreamChunkTool = {
  type: 'tool-event';
  name: string;
  status: 'start' | 'progress' | 'success' | 'error';
  payload?: unknown;
};
export type StreamChunk = StreamChunkText | StreamChunkTool;

export interface AgentMessagePartText {
  type: 'text';
  text: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: AgentMessagePartText[]; // minimal for Phase 2
}

export interface RuntimeData {
  projectId?: string;
  provider?: string;
  model?: string;
  mcpEnabled?: boolean;
}

export type ChatTransport = (
  messages: AgentMessage[],
  runtime?: RuntimeData
) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>;

export async function* defaultWebTransport(
  messages: AgentMessage[],
  runtime?: RuntimeData
): AsyncIterable<StreamChunk> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, data: runtime ?? {} }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Chat transport error: ${res.status}`);
  }
  const reader = res.body.getReader();
  try {
    yield* readJsonLines(reader);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function* readJsonLines(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          yield JSON.parse(line) as StreamChunk;
        } catch {
          // ignore malformed line
        }
      }
      idx = buffer.indexOf('\n');
    }
  }
}

// Helper for building a minimal user message from text
export function buildUserMessage(text: string): AgentMessage {
  return {
    id: generateUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  } satisfies AgentMessage;
}
