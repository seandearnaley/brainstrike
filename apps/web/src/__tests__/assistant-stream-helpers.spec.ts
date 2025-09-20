import { describe, expect, it } from 'vitest';
import { processAgentStream, type StreamChunk } from '../assistant-stream-helpers';

class MockToolCallController {
  public argsText: {
    append: (text: string) => void;
    appended: string;
  } = {
    appended: '',
    append: (text: string) => {
      this.argsText.appended += String(text ?? '');
    },
  };
  public result: unknown = undefined;
  public closed = false;

  setResponse(opts: { result: unknown; isError: boolean }) {
    this.result = { ...opts };
  }
  close() {
    this.closed = true;
  }
}

class MockController {
  public textParts = 0;
  public text = '';
  public toolControllers: MockToolCallController[] = [];
  public finished: unknown[] = [];
  public closed = false;

  addTextPart() {
    this.textParts += 1;
  }
  appendText(t: string) {
    this.text += t;
  }
  addToolCallPart() {
    const c = new MockToolCallController();
    this.toolControllers.push(c);
    return c;
  }
  enqueue(chunk: unknown) {
    this.finished.push(chunk);
  }
  close() {
    this.closed = true;
  }
}

async function* toAsyncIterable(parts: StreamChunk[]) {
  for (const p of parts) yield p;
}

describe('assistant-stream-helpers', () => {
  it('appends tool progress as assistant text and closes on finish', async () => {
    const ctrl = new MockController();
    const stream = toAsyncIterable([
      { type: 'tool-event', name: 'filesystem.list', status: 'start' },
      {
        type: 'tool-event',
        name: 'filesystem.list',
        status: 'progress',
        payload: { step: 'Scanning', percent: 42 },
      },
      { type: 'tool-event', name: 'filesystem.list', status: 'success', payload: { ok: true } },
      {
        type: 'message-finish',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 2 },
        path: [],
      },
    ] satisfies StreamChunk[]);

    await processAgentStream(ctrl as unknown as Parameters<typeof processAgentStream>[0], stream);

    // A text part should be created for the first tool event when none existed
    expect(ctrl.textParts).toBeGreaterThan(0);
    // Progress was formatted into a line and appended with a trailing newline
    expect(ctrl.text).toMatch(/Scanning \(42%\)\n$/);
    // Tool controller captured a response and is closed
    expect(ctrl.toolControllers[0]?.closed).toBe(true);
    // Final message finish chunk enqueued
    expect(ctrl.finished[0]).toMatchObject({ type: 'message-finish' });
    expect(ctrl.closed).toBe(true);
  });

  it('creates a text container on tool start before any text', async () => {
    const ctrl = new MockController();
    const stream = toAsyncIterable([
      { type: 'tool-event', name: 'web.searchDocs', status: 'start' },
      { type: 'finish', usage: { promptTokens: 0, completionTokens: 0 } },
    ] as StreamChunk[]);

    await processAgentStream(ctrl as unknown as Parameters<typeof processAgentStream>[0], stream);
    expect(ctrl.textParts).toBe(1);
  });
});
