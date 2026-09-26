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

const start = { payload: {}, runId: 'root-run', type: 'start' };
const finish = { payload: {}, runId: 'root-run', type: 'finish' };

/** A delegation `tool-output` envelope exactly as Mastra's ToolStream writes it. */
const envelope = (output: Record<string, unknown>, toolCallId = 'call-1') => ({
  from: 'USER',
  payload: { output, toolCallId, toolName: 'agent-explore' },
  runId: 'root-run',
  type: 'tool-output',
});

// Live GLM run 19 (2026-09-15): while the dispatching turn is still open,
// Mastra's background executor delivered each child output through the task
// AND that turn's own writer (patched to the task only), and its suspend still
// emits a parent-level pause for the delegation call on the turn before the
// task parks. Every chunk below is in that arrival order.
describe('projectBackgroundStream: one delivery per background call', () => {
  it('keeps a resumed task background-owned when its fresh root leg never saw its start', async () => {
    const owners = new Set<string>();
    const out: unknown[] = [];
    for await (const part of projectBackgroundStream(
      (async function* () {
        yield start;
        yield lifecycle('background-task-resumed');
        yield lifecycle('background-task-output', {
          payload: envelope({ payload: { toolCallId: 'leaf-1' }, type: 'tool-call-approval' }),
        });
        yield lifecycle('background-task-suspended', { suspendedAt: 'parked' });
        yield finish;
      })(),
      true,
      owners
    )) {
      out.push(part);
    }
    expect(out.map(typeOf)).toContain('background-task-suspended');
    expect(owners).toContain(JSON.stringify(['root-run', 'call-1']));
  });

  it("projects a background call's child output from its task", async () => {
    const frames = [envelope({ type: 'start' }), envelope({ type: 'step-start' })];
    const out = await collect([
      start,
      lifecycle('background-task-started'),
      ...frames.map((frame) => lifecycle('background-task-output', { payload: frame })),
      lifecycle('background-task-completed', { result: {} }),
      finish,
    ]);
    expect(out.map(typeOf)).toEqual([
      'start',
      'tool-output',
      'tool-output',
      'tool-result',
      'finish',
    ]);
  });

  it("reports a background call's output on its dispatching turn as a contract break", async () => {
    // patches/@mastra__core@1.64.0.patch makes the task a background call's
    // only output delivery. A turn copy means that patch no longer applies,
    // and every child part the filter cannot attribute would project twice.
    await expect(
      collect([
        start,
        lifecycle('background-task-started'),
        lifecycle('background-task-output', { payload: envelope({ type: 'start' }) }),
        envelope({ type: 'start' }),
      ])
    ).rejects.toThrow('streamed output on its dispatching turn');
  });

  it.for(['tool-call-approval', 'tool-call-suspended'])(
    "projects a background call's pause from its task only, never the dispatching turn's own %s",
    async (type) => {
      const out = await collect([
        start,
        lifecycle('background-task-started'),
        lifecycle('background-task-output', {
          payload: envelope({ payload: { toolCallId: 'leaf-1' }, type }),
        }),
        {
          payload: { toolCallId: 'call-1', toolName: 'brainstrike_grepSearch' },
          runId: 'root-run',
          type,
        },
        lifecycle('background-task-suspended', { suspendedAt: '2026-09-15T15:40:40.510Z' }),
        finish,
      ]);
      expect(out.map(typeOf)).toEqual([
        'start',
        'tool-output',
        'background-task-suspended',
        'finish',
      ]);
    }
  );

  it("forwards a foreground call's own output and pause unchanged", async () => {
    const out = await collect([
      start,
      envelope({ type: 'start' }, 'call-2'),
      {
        payload: { toolCallId: 'call-2', toolName: 'agent-explore' },
        runId: 'root-run',
        type: 'tool-call-approval',
      },
      finish,
    ]);
    expect(out.map(typeOf)).toEqual(['start', 'tool-output', 'tool-call-approval', 'finish']);
  });

  it("reports a turn copy forwarded before the turn acknowledged the call's background dispatch", async () => {
    await expect(
      collect([start, envelope({ type: 'start' }), lifecycle('background-task-started')])
    ).rejects.toThrow('before the turn acknowledged the dispatch');
  });
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

  it('reports a child output with a non-string type as a contract break, not a TypeError', async () => {
    await expect(
      collect([
        { payload: {}, runId: 'root-run', type: 'start' },
        lifecycle('background-task-started'),
        lifecycle('background-task-output', {
          payload: { payload: {}, runId: 'child-run', type: null },
        }),
      ])
    ).rejects.toThrow('omitted its delegation envelope');
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
