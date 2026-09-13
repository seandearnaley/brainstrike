import { describe, expect, it } from 'vitest';
import { projectBackgroundStream } from '../background-stream';

async function collect(parts: unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const part of projectBackgroundStream(
    (async function* () {
      yield* parts;
    })()
  )) {
    out.push(part);
  }
  return out;
}

const typeOf = (part: unknown): string =>
  typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string'
    ? (part as { type: string }).type
    : '';

const lifecycle = (type: string, extra: Record<string, unknown> = {}) => ({
  payload: { taskId: 'task-1', toolCallId: 'call-1', ...extra },
  runId: 'root-run',
  type,
});

describe('projectBackgroundStream', () => {
  it('forwards a raw data-* child chunk exactly as the foreground writer would', async () => {
    // 2026-09-13 (thread-2584030d): a background Explorer child's observational
    // memory chunk arrived as the task output and the projection threw
    // "omitted its delegation envelope", failing the root run and killing all
    // four children. Mastra's ToolStream.custom() writes data-* chunks RAW in
    // the foreground path, so the background path must accept the same shape.
    const omChunk = {
      payload: { generation: 0 },
      runId: 'child-run',
      type: 'data-om-buffering-start',
    };
    const out = await collect([
      { payload: {}, runId: 'root-run', type: 'start' },
      lifecycle('background-task-started'),
      lifecycle('background-task-output', { payload: omChunk }),
      lifecycle('background-task-completed', { result: { text: 'done' } }),
      {
        payload: { usage: { inputTokens: 1, outputTokens: 1 } },
        runId: 'root-run',
        type: 'finish',
      },
    ]);
    expect(out.map(typeOf)).toEqual(['start', 'data-om-buffering-start', 'tool-result', 'finish']);
    expect(out[1]).toEqual(omChunk);
  });

  it('forwards the child envelopes exactly as before', async () => {
    const envelope = {
      payload: { output: { type: 'text-delta' }, toolCallId: 'call-1', toolName: 'agent-explore' },
      runId: 'child-run',
      type: 'tool-output',
    };
    const out = await collect([
      { payload: {}, runId: 'root-run', type: 'start' },
      lifecycle('background-task-started'),
      lifecycle('background-task-output', { payload: envelope }),
      lifecycle('background-task-completed', { result: {} }),
      { payload: {}, runId: 'root-run', type: 'finish' },
    ]);
    expect(out[1]).toEqual(envelope);
  });

  it.for(['text-delta', 'datafoo', 'data'])(
    'still rejects a background child output that is neither an envelope nor a data chunk (%s)',
    async (type) => {
      const seen: unknown[] = [];
      const stream = projectBackgroundStream(
        (async function* () {
          yield { payload: {}, runId: 'root-run', type: 'start' };
          yield lifecycle('background-task-started');
          yield lifecycle('background-task-output', {
            payload: { payload: {}, runId: 'child-run', type },
          });
        })()
      );
      await expect(
        (async () => {
          for await (const part of stream) {
            seen.push(part);
          }
        })()
      ).rejects.toThrow('omitted its delegation envelope');
      // Mid-stream, not pre-flight: the parent's own start was already forwarded.
      expect(seen.map(typeOf)).toEqual(['start']);
    }
  );
});
