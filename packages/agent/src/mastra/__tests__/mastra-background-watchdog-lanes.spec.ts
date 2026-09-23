/**
 * The root stream watchdog over a BACKGROUND leg (docs/agents/assistant-runtime.md,
 * "Stream inactivity watchdog").
 *
 * On a background leg the watchdog wraps the host idle loop's COMBINED stream:
 * the parent's own turns, every running child's output folded in as
 * `background-task-output`, and the loop's own bookkeeping (native lifecycle
 * events, ledger rows). Each child is its own producer with its own phase, so
 * a child's time-to-first-output, its reasoning gaps and its guarded tool
 * calls are judged against the SAME phase windows the parent's are — never
 * against the tight `streaming` window the parent's last `finish` left behind.
 *
 * Parts below are the real shapes: the manager's `background-task-*` events
 * (`BackgroundTaskManager.stream`) and the delegation envelope Mastra's
 * ToolStream writes a child's part in (`background-stream.spec.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamStalledError, withInactivityTimeout } from '../../stream/with-inactivity-timeout';
import { resolveMastraInactivityOptions } from '../agent-streaming';

const WINDOWS = {
  firstOutputMs: 5000,
  interOutputMs: 1000,
  reasoningGapMs: 4000,
  toolExecutingMs: 9000,
} as const;

const GUARDED = new Set(['brainstrike_executeCommand']);

const root = (type: string, payload: Record<string, unknown> = {}) => ({
  payload,
  runId: 'root-run',
  type,
});

/** One native lifecycle event for task `taskId` (dispatched by call `call-<taskId>`). */
const lifecycle = (type: string, taskId: string, extra: Record<string, unknown> = {}) => ({
  payload: {
    agentId: 'root',
    runId: 'root-run',
    taskId,
    toolCallId: `call-${taskId}`,
    toolName: 'agent-explore',
    ...extra,
  },
  type,
});

/** A child's own part, as its background task publishes it. */
const child = (taskId: string, type: string, payload: Record<string, unknown> = {}) =>
  lifecycle('background-task-output', taskId, {
    payload: {
      from: 'USER',
      payload: {
        output: { payload, runId: `child-run-${taskId}`, type },
        toolCallId: `call-${taskId}`,
        toolName: 'agent-explore',
      },
      runId: 'root-run',
      type: 'tool-output',
    },
  });

/** The parent's first turn: it dispatches `taskIds` in the background and finishes. */
const dispatchingTurn = (...taskIds: string[]) => [
  root('start'),
  root('step-start'),
  ...taskIds.map((taskId) =>
    root('tool-call', { toolCallId: `call-${taskId}`, toolName: 'agent-explore' })
  ),
  ...taskIds.map((taskId) => lifecycle('background-task-started', taskId)),
  ...taskIds.map((taskId) =>
    root('tool-result', { toolCallId: `call-${taskId}`, toolName: 'agent-explore' })
  ),
  root('step-start'),
  root('text-delta', { text: 'Dispatched.' }),
  root('finish'),
  ...taskIds.map((taskId) => lifecycle('background-task-running', taskId)),
];

function createSource() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  return {
    finish() {
      done = true;
      notify();
    },
    async *iterate(): AsyncIterableIterator<unknown> {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift();
        }
        if (done) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    push(...parts: unknown[]) {
      queue.push(...parts);
      notify();
    },
  };
}

/** Drive the production Mastra options over a controllable combined stream. */
function watchLeg() {
  const source = createSource();
  let stall: StreamStalledError | undefined;
  let ended = false;
  const drained = (async () => {
    for await (const _part of withInactivityTimeout(
      source.iterate(),
      WINDOWS,
      resolveMastraInactivityOptions(undefined, GUARDED, () => {})
    )) {
      // Drain; the verdict is the watchdog's.
    }
    ended = true;
  })().catch((error: unknown) => {
    if (!(error instanceof StreamStalledError)) {
      throw error;
    }
    stall = error;
  });
  return {
    drained,
    ended: () => ended,
    finish: () => source.finish(),
    async push(...parts: unknown[]) {
      source.push(...parts);
      await vi.advanceTimersByTimeAsync(0);
    },
    stall: () => stall,
  };
}

describe('the root watchdog judges each background child by its own phase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a child's time-to-first-output rides the first-output window, not the parent's streaming one", async () => {
    const leg = watchLeg();
    await leg.push(...dispatchingTurn('t1'), child('t1', 'start'), child('t1', 'step-start'));
    // A 300k-token child context: minutes before its first token.
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(leg.stall()).toBeUndefined();
    await leg.push(child('t1', 'text-delta', { text: 'found it' }));
    await leg.push(lifecycle('background-task-completed', 't1'));
    leg.finish();
    await leg.drained;
    expect(leg.stall()).toBeUndefined();
    expect(leg.ended()).toBe(true);
  });

  it("a child's reasoning gap rides the reasoning window", async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      child('t1', 'reasoning-delta', { text: 'thinking' })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.reasoningGapMs - 500);
    expect(leg.stall()).toBeUndefined();
    leg.finish();
    await leg.drained;
    expect(leg.stall()).toBeUndefined();
  });

  it("a child's GUARDED tool call rides the tool-executing backstop, and a stall there is tool-executing", async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      child('t1', 'tool-call', {
        toolCallId: 'child-command',
        toolName: 'brainstrike_executeCommand',
      })
    );
    // A silent build: longer than any provider window, inside the guard's.
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs + 1000);
    expect(leg.stall()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOWS.toolExecutingMs);
    await leg.drained;
    // Terminal, never retried: a continuation could start the command twice.
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.toolExecutingMs,
      phase: 'tool-executing',
    });
  });

  it("an UNGUARDED child call stays on the child's provider windows", async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      child('t1', 'tool-call', { toolCallId: 'child-memory', toolName: 'updateWorkingMemory' })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs + 1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it('fan-out: a sibling returning and the parent answering it never tighten a child still waiting on its first output', async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1', 't2'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      child('t2', 'start'),
      child('t2', 'step-start'),
      child('t2', 'text-delta', { text: 'quick answer' }),
      child('t2', 'finish'),
      lifecycle('background-task-completed', 't2'),
      // The loop wakes the parent for t2; t1 is still on its first token.
      root('start'),
      root('step-start'),
      root('text-delta', { text: 'One returned.' }),
      root('finish')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(leg.stall()).toBeUndefined();
    leg.finish();
    await leg.drained;
    expect(leg.stall()).toBeUndefined();
  });

  it("a child's step boundary never clears the PARENT's own running command", async () => {
    const leg = watchLeg();
    await leg.push(
      root('start'),
      root('step-start'),
      root('tool-call', { toolCallId: 'call-t1', toolName: 'agent-explore' }),
      root('tool-call', { toolCallId: 'root-command', toolName: 'brainstrike_executeCommand' }),
      lifecycle('background-task-started', 't1'),
      root('tool-result', { toolCallId: 'call-t1', toolName: 'agent-explore' }),
      lifecycle('background-task-running', 't1'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      child('t1', 'text-delta', { text: 'first step' }),
      child('t1', 'step-start'),
      child('t1', 'text-delta', { text: 'second step' }),
      child('t1', 'finish'),
      lifecycle('background-task-completed', 't1')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs + 1000);
    expect(leg.stall()).toBeUndefined();
    leg.finish();
    await leg.drained;
  });

  it("a returned child's lane closes: the parent's streaming window applies again", async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      lifecycle('background-task-completed', 't1')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs + 1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it('a parked child waits on a human: its suspension closes its lane, running call and all', async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      // Even with no settle observed, a parked task is not executing.
      child('t1', 'tool-call', {
        toolCallId: 'child-command',
        toolName: 'brainstrike_executeCommand',
      }),
      lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs + 1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it('a terminal that outruns the dispatch acknowledgement never leaves its lane open', async () => {
    const leg = watchLeg();
    await leg.push(
      root('start'),
      root('step-start'),
      root('tool-call', { toolCallId: 'call-t1', toolName: 'agent-explore' }),
      // A fast child's terminal reaches the loop before the turn's own ack.
      lifecycle('background-task-completed', 't1'),
      lifecycle('background-task-started', 't1'),
      root('tool-result', { toolCallId: 'call-t1', toolName: 'agent-explore' }),
      root('finish'),
      lifecycle('background-task-running', 't1')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs + 1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it("a re-announced running task never resets its lane's running call", async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      child('t1', 'step-start'),
      child('t1', 'tool-call', {
        toolCallId: 'child-command',
        toolName: 'brainstrike_executeCommand',
      }),
      // A new manager subscriber is re-told every running task.
      lifecycle('background-task-running', 't1')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs + 1000);
    expect(leg.stall()).toBeUndefined();
    leg.finish();
    await leg.drained;
  });

  it('a live-resumed child reopens its lane before its first part arrives', async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' }),
      lifecycle('background-task-resumed', 't1')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(leg.stall()).toBeUndefined();
    leg.finish();
    await leg.drained;
  });

  it("the loop's own bookkeeping never tightens the parent's first-output wait", async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      lifecycle('background-task-completed', 't1'),
      // The wakeup continuation opens; its first token is minutes away.
      root('start'),
      root('step-start'),
      // A durable ledger row and a sibling's late lifecycle land meanwhile.
      { event: { kind: 'delegation.ledger' }, type: 'run-event' },
      lifecycle('background-task-running', 't2'),
      lifecycle('background-task-completed', 't2')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(leg.stall()).toBeUndefined();
    leg.finish();
    await leg.drained;
  });
});
