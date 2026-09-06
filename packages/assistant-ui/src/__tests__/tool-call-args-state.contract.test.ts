import { AssistantMessageAccumulator, type AssistantStreamChunk } from 'assistant-stream';
import { describe, expect, it } from 'vitest';
import { readToolCallArgsState } from '../tool-call-progress';

/**
 * Pins the runtime shape `readToolCallArgsState` and `useToolCallElapsedMs`
 * depend on against the INSTALLED assistant-stream accumulator — the object
 * that actually builds the part `ToolFallback` receives. Not a re-statement of
 * our own reader: if a bump renames `state`, flips `isArgsComplete`, or drops
 * `timing`, this fails here instead of the card silently reading "Running"
 * through a two-minute argument stream.
 */
async function accumulate(chunks: readonly AssistantStreamChunk[]) {
  const source = new ReadableStream<AssistantStreamChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const snapshots: unknown[] = [];
  const reader = source
    .pipeThrough(new AssistantMessageAccumulator({ throttle: false }))
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    snapshots.push(value);
  }
  return snapshots;
}

function toolPart(snapshot: unknown): Record<string, unknown> {
  const parts = (snapshot as { parts?: readonly unknown[] }).parts;
  const part = parts?.[0];
  if (!(part && typeof part === 'object')) {
    throw new Error('expected the accumulated message to carry a tool-call part');
  }
  return part as Record<string, unknown>;
}

const start: AssistantStreamChunk = {
  part: { toolCallId: 'call-1', toolName: 'brainstrike.writeFile', type: 'tool-call' },
  path: [],
  type: 'part-start',
};
const delta: AssistantStreamChunk = {
  path: [0],
  textDelta: '{"path":"a.ts","content":"',
  type: 'text-delta',
};
const argsFinish: AssistantStreamChunk = { path: [0], type: 'tool-call-args-text-finish' };
const result: AssistantStreamChunk = {
  isError: false,
  path: [0],
  result: { ok: true },
  type: 'result',
};

describe('assistant-stream tool-call part contract (BST-849)', () => {
  it('opens the part as partial-call with a startedAt timing while arguments stream', async () => {
    const [opened, streamed] = await accumulate([start, delta]);
    for (const snapshot of [opened, streamed]) {
      const part = toolPart(snapshot);
      expect(readToolCallArgsState(part)).toBe('partial-call');
      expect(part['status']).toEqual({ isArgsComplete: false, type: 'running' });
      expect(typeof (part['timing'] as { startedAt?: unknown } | undefined)?.startedAt).toBe(
        'number'
      );
    }
    expect(toolPart(streamed)['argsText']).toBe('{"path":"a.ts","content":"');
  });

  it('moves to call on args-text-finish without ever flipping isArgsComplete', async () => {
    const snapshots = await accumulate([start, delta, argsFinish]);
    const part = toolPart(snapshots.at(-1));
    expect(readToolCallArgsState(part)).toBe('call');
    // The typed flag stays false — which is why the card reads `state`, not it.
    expect(part['status']).toEqual({ isArgsComplete: false, type: 'running' });
  });

  it('stamps completedAt and state=result once the result lands', async () => {
    const snapshots = await accumulate([start, delta, argsFinish, result]);
    const part = toolPart(snapshots.at(-1));
    expect(readToolCallArgsState(part)).toBe('result');
    const timing = part['timing'] as { completedAt?: unknown; startedAt?: unknown };
    expect(typeof timing.startedAt).toBe('number');
    expect(typeof timing.completedAt).toBe('number');
  });
});
