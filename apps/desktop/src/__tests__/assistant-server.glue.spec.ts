import { describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent', () => {
  const byKey = new Map<string, { controller: { close: () => void }; name: string }>();
  const nameToKeys = new Map<string, string[]>();
  return {
    createToolRegistry: () => ({ byKey, nameToKeys }),
    startToolCall: (
      registry: { byKey: typeof byKey; nameToKeys: typeof nameToKeys },
      name: string,
      _payload: unknown,
      controller: { close: () => void }
    ) => {
      const key = `${name}-1`;
      registry.byKey.set(key, { controller, name });
      registry.nameToKeys.set(name, [key]);
    },
    recordToolProgress: () => 'Scanning (42%)',
    completeToolCall: (
      registry: { byKey: typeof byKey; nameToKeys: typeof nameToKeys },
      name: string
    ) => {
      const key = registry.nameToKeys.get(name)?.[0];
      const entry = key ? registry.byKey.get(key) : undefined;
      if (entry) entry.controller.close();
    },
  } as unknown as typeof import('@brainstrike/agent');
});

import { __assistantServerTest } from '../assistant-server';

type StreamChunk = Parameters<
  typeof __assistantServerTest.processAgentStream
>[1] extends AsyncIterable<infer T>
  ? T
  : never;

class MockToolCallController {
  closed = false;
  argsText = { append: (_: string) => {} } as const;
  setResponse = (_: { result: unknown; isError: boolean }) => {};
  close = () => {
    this.closed = true;
  };
}

class MockCtrl {
  textParts = 0;
  text = '';
  toolControllers: MockToolCallController[] = [];
  closed = false;
  finished: unknown[] = [];

  addTextPart() {
    this.textParts += 1;
  }
  appendText(t: string) {
    this.text += String(t ?? '');
  }
  addToolCallPart() {
    const c = new MockToolCallController();
    this.toolControllers.push(c);
    return c;
  }
  close() {
    this.closed = true;
  }
  enqueue(chunk: unknown) {
    this.finished.push(chunk);
  }
}

async function* seq(parts: StreamChunk[]) {
  for (const p of parts) yield p;
}

describe('assistant-server stream glue', () => {
  it('normalizes finish to message-finish, appends progress, and closes controllers', async () => {
    const ctrl = new MockCtrl();
    const stream = seq([
      { type: 'tool-event', name: 'filesystem.list', status: 'start' } as StreamChunk,
      {
        type: 'tool-event',
        name: 'filesystem.list',
        status: 'progress',
        payload: { step: 'Scanning', percent: 42 },
      } as StreamChunk,
      {
        type: 'tool-event',
        name: 'filesystem.list',
        status: 'success',
        payload: { ok: true },
      } as StreamChunk,
      { type: 'finish', usage: { promptTokens: 3, completionTokens: 5 } } as StreamChunk,
    ]);

    await __assistantServerTest.processAgentStream(
      ctrl as unknown as Parameters<typeof __assistantServerTest.processAgentStream>[0],
      stream,
      undefined,
      false
    );

    // A text container is created for tool-start, and once more for progress text
    expect(ctrl.textParts).toBeGreaterThanOrEqual(1);
    // Progress appended (from recordToolProgress mock)
    expect(ctrl.text).toMatch(/Scanning \(42%\)\n$/);
    // Finish normalized and enqueued
    expect(ctrl.finished[0]).toMatchObject({ type: 'message-finish', finishReason: 'stop' });
    // Controller closed by completeToolCall or finally
    expect(ctrl.toolControllers[0]?.closed).toBe(true);
    // Stream controller closed in finally
    expect(ctrl.closed).toBe(true);
  });
});
