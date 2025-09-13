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

// Transport can optionally expose a `cancel()` to support Stop in UI.
export type CancellableIterable<T> = AsyncIterable<T> & { cancel?: () => void };

export type ChatTransport = (
  messages: AgentMessage[],
  runtime?: RuntimeData
) => CancellableIterable<StreamChunk> | Promise<CancellableIterable<StreamChunk>>;

export async function defaultWebTransport(
  messages: AgentMessage[],
  runtime?: RuntimeData
): Promise<CancellableIterable<StreamChunk>> {
  const ctrl = new AbortController();
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, data: runtime ?? {} }),
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Chat transport error: ${res.status}`);
  }
  const reader = res.body.getReader();
  let cancelled = false;

  async function* gen(): AsyncIterable<StreamChunk> {
    try {
      for await (const item of readJsonLines(reader)) {
        if (cancelled) break;
        yield item as StreamChunk;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  const iterable = gen() as CancellableIterable<StreamChunk>;
  iterable.cancel = () => {
    cancelled = true;
    try {
      reader.cancel().catch(() => {});
    } catch {}
    try {
      ctrl.abort();
    } catch {}
  };
  return iterable;
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
