import type { AgentMessage, AgentMessagePartText, StreamChunk, StreamIterator } from '../index';

export interface OpenAIStreamRuntime {
  apiKey: string;
  model?: string;
  signal?: AbortSignal | null | undefined;
}

function toChatMessages(
  messages: AgentMessage[]
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return messages.map((m) => {
    const textParts = m.parts.filter((p) => p.type === 'text') as AgentMessagePartText[];
    const content = textParts
      .map((p) => p.text)
      .join(' ')
      .trim();
    return { role: m.role, content };
  });
}

function buildHeaders(apiKey: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${apiKey}`);
  h.set('Accept', 'text/event-stream');
  return h;
}

function emitDeltaFromData(data: string): string | '' {
  try {
    const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
    return json?.choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}

function parseSSELines(chunk: string): { deltas: string[]; done: boolean } {
  const lines = chunk.split('\n');
  const deltas: string[] = [];
  let done = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('data:')) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      break;
    }
    const delta = emitDeltaFromData(data);
    if (delta) {
      deltas.push(delta);
    }
  }
  return { deltas, done };
}

function processBufferedData(buffer: string): {
  deltas: string[];
  rest: string;
  done: boolean;
} {
  let rest = buffer;
  const deltas: string[] = [];
  let done = false;

  let idx = rest.indexOf('\n\n');
  while (idx >= 0) {
    const chunk = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 2);
    const parsed = parseSSELines(chunk);
    deltas.push(...parsed.deltas);
    if (parsed.done) {
      done = true;
      break;
    }
    idx = rest.indexOf('\n\n');
  }

  return { deltas, rest, done };
}

function parseTailBuffer(buffer: string): { deltas: string[]; done: boolean } {
  // Handle any remaining partial lines after the stream ends
  const lines = buffer.split('\n').filter(Boolean).join('\n');
  return parseSSELines(lines);
}

async function* readDeltasFromStream(
  stream: AsyncIterable<Uint8Array> | null
): AsyncIterableIterator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  if (stream) {
    for await (const value of stream) {
      buffer += decoder.decode(value, { stream: true });
      const parsed = processBufferedData(buffer);
      buffer = parsed.rest;
      for (const delta of parsed.deltas) {
        yield delta;
      }
      if (parsed.done) {
        return;
      }
    }
  }

  if (buffer.length > 0) {
    const tail = parseTailBuffer(buffer);
    for (const delta of tail.deltas) {
      yield delta;
    }
  }
}

export async function toOpenAIStream(
  messages: AgentMessage[],
  runtime: OpenAIStreamRuntime
): Promise<StreamIterator> {
  const modelId = runtime.model ?? 'gpt-4o';
  const chatMessages = toChatMessages(messages);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: buildHeaders(runtime.apiKey),
    body: JSON.stringify({
      model: modelId,
      messages: chatMessages,
      temperature: 0.2,
      stream: true,
    }),
    signal: (runtime.signal ?? null) as AbortSignal | null,
  });

  if (!(res.ok && res.body)) {
    const errText = await res.text().catch(() => '');
    async function* errIter(): AsyncIterableIterator<StreamChunk> {
      yield { type: 'text-delta', value: `\n[provider_error ${res.status}] ${errText}` };
    }
    return errIter();
  }

  async function* iter(): AsyncIterableIterator<StreamChunk> {
    const stream = res.body as unknown as AsyncIterable<Uint8Array> | null;
    for await (const delta of readDeltasFromStream(stream)) {
      yield { type: 'text-delta', value: delta } satisfies StreamChunk;
    }
  }
  return iter();
}
