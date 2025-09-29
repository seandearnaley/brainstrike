import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../index';
import { AssistantDataStreamSession } from '../stream/data-stream';

type Encoded = { code: string; value: unknown };

function createAsyncStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function readResponse(response: Response): Promise<string[]> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      buffer += decoder.decode(value, { stream: true });
    }
  }
  buffer += decoder.decode();
  return buffer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLines(lines: string[]): Encoded[] {
  return lines.map((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`invalid data stream line: ${line}`);
    }
    const code = line.slice(0, idx);
    const payload = line.slice(idx + 1);
    return {
      code,
      value: JSON.parse(payload),
    } satisfies Encoded;
  });
}

describe('AssistantDataStreamSession', () => {
  it('encodes mastra chunks into AI SDK data stream lines', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Hello ' },
      { type: 'text-delta', value: 'world' },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'start',
        payload: { toolCallId: 'call-1', args: { city: 'SF' } },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'progress',
        payload: { step: 'input_stream_delta', toolCallId: 'call-1', argsTextDelta: '{"city":' },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'progress',
        payload: { step: 'input_stream_delta', toolCallId: 'call-1', argsTextDelta: '"SF"}' },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'progress',
        payload: { step: 'input_stream_end', toolCallId: 'call-1' },
      },
      {
        type: 'tool-event',
        name: 'weather.lookup',
        status: 'success',
        payload: { toolCallId: 'call-1', output: { tempC: 18 } },
      },
      { type: 'text-delta', value: ' Done.' },
      { type: 'finish', usage: { promptTokens: 5, completionTokens: 7 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'sess-test',
      messageId: 'msg-test',
    });

    const lines = await readResponse(session.createResponse());
    const codes = lines.map((line) => line.slice(0, 1));
    expect(codes).toStrictEqual([
      '2', // start metadata
      'f', // start-step
      '0',
      '0',
      'b',
      'c',
      'c',
      '9',
      'a',
      'e',
      'f', // new step after tool
      '0',
      'e',
      'd',
    ]);

    const events = parseLines(lines);
    const metadata = events[0]?.value as [{ type: string; messageId: string; sessionId: string }];
    expect(metadata?.[0]).toMatchObject({
      type: 'start',
      messageId: 'msg-test',
      sessionId: 'sess-test',
    });

    const toolResult = events.find((evt) => evt.code === 'a')?.value as {
      toolCallId: string;
      result: { tempC: number };
    };
    expect(toolResult?.result).toMatchObject({ tempC: 18 });

    const finish = events.at(-1)?.value as {
      finishReason: string;
      usage: Usage;
    };
    expect(finish?.usage).toStrictEqual({ promptTokens: 5, completionTokens: 7 });
  });

  it('supports resuming from Last-Event-ID', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'First ' },
      { type: 'text-delta', value: 'chunk' },
      { type: 'text-delta', value: '!' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'resume',
      messageId: 'msg-resume',
    });

    const allLines = await readResponse(session.createResponse());
    const resumeIndex = Math.max(0, allLines.length - 2);
    const resumeId = `resume:${resumeIndex}`;

    const resumedLines = await readResponse(
      session.createResponse({ resumeFromEventId: resumeId })
    );
    const expectedTail = allLines.slice(resumeIndex + 1);
    expect(resumedLines).toStrictEqual(expectedTail);
  });

  it('annotates error finishes when tool fails', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'Working...' },
      {
        type: 'tool-event',
        name: 'failing.tool',
        status: 'error',
        payload: { toolCallId: 'oops', error: 'boom' },
      },
      { type: 'finish', usage: { promptTokens: 2, completionTokens: 0 } },
    ];

    const session = new AssistantDataStreamSession(createAsyncStream(chunks), () => {}, {
      sessionId: 'err',
      messageId: 'msg-err',
    });

    const events = parseLines(await readResponse(session.createResponse()));
    const errorChunk = events.find((evt) => evt.code === '3');
    expect(errorChunk?.value).toBe('boom');

    const finish = events.at(-1)?.value as {
      finishReason: string;
    };
    expect(finish?.finishReason).toBe('error');
  });

  it('stops consuming source when response stream is canceled', async () => {
    let consumedCount = 0;
    const maxChunks = 10;

    async function* slowStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < maxChunks; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: 'finish', usage: { promptTokens: 1, completionTokens: maxChunks } };
    }

    const session = new AssistantDataStreamSession(slowStream(), () => {}, {
      sessionId: 'abort-test',
      messageId: 'msg-abort',
    });

    const response = session.createResponse();
    const body = response.body as ReadableStream<Uint8Array> | null;
    expect(body).not.toBeNull();

    const reader = body?.getReader();

    // Read first few chunks
    await reader.read();
    await reader.read();
    await reader.read();

    // Cancel the stream
    await reader.cancel();

    // Give it time to process any in-flight chunks
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should have stopped consuming well before maxChunks
    expect(consumedCount).toBeLessThan(maxChunks);
    // Should have consumed at least the chunks we read (abort is very responsive)
    expect(consumedCount).toBeGreaterThanOrEqual(2);
  });

  it('handles abort when response is canceled immediately', async () => {
    let consumedCount = 0;

    async function* longStream(): AsyncIterableIterator<StreamChunk> {
      for (let i = 0; i < 100; i++) {
        consumedCount++;
        yield { type: 'text-delta', value: `chunk${i} ` };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      yield { type: 'finish', usage: { promptTokens: 1, completionTokens: 100 } };
    }

    const session = new AssistantDataStreamSession(longStream(), () => {}, {
      sessionId: 'immediate-abort',
      messageId: 'msg-immediate',
    });

    const response = session.createResponse();
    const body = response.body as ReadableStream<Uint8Array> | null;
    const reader = body?.getReader();

    // Cancel immediately without reading
    await reader.cancel();

    // Give it minimal time
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have consumed very few chunks
    expect(consumedCount).toBeLessThan(10);
  });
});

type Usage = { promptTokens: number; completionTokens: number };
