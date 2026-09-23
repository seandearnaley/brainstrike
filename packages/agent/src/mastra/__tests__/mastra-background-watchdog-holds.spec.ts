/**
 * The root stream watchdog over a BACKGROUND leg (docs/agents/assistant-runtime.md,
 * "Stream inactivity watchdog").
 *
 * On a background leg the watchdog wraps the host idle loop's COMBINED stream:
 * the parent's own turns, every running child's output folded in as
 * `background-task-output`, and the loop's own bookkeeping (native lifecycle
 * events, ledger rows). The parent watchdog judges only the PARENT's own
 * output: a child's parts are bookkeeping that moves no parent phase, and a
 * child's liveness belongs to that child's own watchdog
 * (`background-child-watchdog.ts`). Background tasks HOLD the parent's stream
 * open; while one is watched by its own watchdog the parent judges nothing,
 * and work nothing watches waits at the first-output window.
 *
 * Parts below are the real shapes: the manager's `background-task-*` events
 * (`BackgroundTaskManager.stream`) and the delegation envelope Mastra's
 * ToolStream writes a child's part in (`background-stream.spec.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type HeldWorkWatch,
  StreamStalledError,
  withInactivityTimeout,
} from '../../stream/with-inactivity-timeout';
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

/**
 * A controllable stand-in for the per-child watchdogs (`BackgroundChildWatchdogs`):
 * `true` watches every task, `false` none, a set exactly those task ids.
 */
function createWatch(
  initial: boolean | ReadonlySet<string>
): HeldWorkWatch & { set(watching: boolean): void } {
  let watched = initial;
  let changed = Promise.withResolvers<void>();
  return {
    changed: () => changed.promise,
    set(next) {
      watched = next;
      const settled = changed;
      changed = Promise.withResolvers<void>();
      settled.resolve();
    },
    watching: (held) => {
      const current = watched;
      return typeof current === 'boolean'
        ? current
        : [...held].some((taskId) => current.has(taskId));
    },
  };
}

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
function watchLeg(heldWork: HeldWorkWatch = createWatch(false)) {
  const source = createSource();
  let stall: StreamStalledError | undefined;
  let ended = false;
  const drained = (async () => {
    for await (const _part of withInactivityTimeout(
      source.iterate(),
      WINDOWS,
      resolveMastraInactivityOptions(undefined, GUARDED, () => {}, heldWork)
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

describe('the root watchdog judges only the parent; its children hold it open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a child's output never moves the parent's phase", async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1', 't2'),
      lifecycle('background-task-completed', 't2'),
      // The loop wakes the parent for t2; its continuation waits on a first token.
      root('start'),
      root('step-start'),
      // t1 answers meanwhile: its text is the CHILD's, not the parent's.
      child('t1', 'text-delta', { text: 'child answer' }),
      child('t1', 'finish'),
      lifecycle('background-task-completed', 't1')
    );
    // Nothing holds the leg now: the parent's own first-output wait applies.
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(leg.stall()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
  });

  it('while a running child is watched by its own watchdog, the parent judges nothing', async () => {
    const leg = watchLeg(createWatch(true));
    await leg.push(...dispatchingTurn('t1'), child('t1', 'start'), child('t1', 'step-start'));
    // Far past every window: a child's silence is its own watchdog's to judge.
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(leg.stall()).toBeUndefined();
    await leg.push(lifecycle('background-task-completed', 't1'));
    leg.finish();
    await leg.drained;
    expect(leg.stall()).toBeUndefined();
    expect(leg.ended()).toBe(true);
  });

  it('a dispatched child nothing watches yet holds the parent at the first-output window', async () => {
    const leg = watchLeg();
    await leg.push(
      ...dispatchingTurn('t1').filter((part) => part.type !== 'background-task-running')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(leg.stall()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
  });

  it("once a child's own watch ends, its terminal is awaited at the first-output window", async () => {
    const watch = createWatch(true);
    const leg = watchLeg(watch);
    await leg.push(...dispatchingTurn('t1'), child('t1', 'finish'));
    await vi.advanceTimersByTimeAsync(30_000);
    watch.set(false);
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 1);
    expect(leg.stall()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
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
      child('t1', 'finish'),
      lifecycle('background-task-completed', 't1')
    );
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

  it("a returned child releases its hold: the parent's streaming window applies again", async () => {
    const leg = watchLeg(createWatch(true));
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      lifecycle('background-task-completed', 't1')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs + 1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it('a parked child waits on a human: its suspension releases its hold', async () => {
    const leg = watchLeg(createWatch(true));
    await leg.push(
      ...dispatchingTurn('t1'),
      child('t1', 'start'),
      child('t1', 'tool-call', {
        toolCallId: 'child-command',
        toolName: 'brainstrike_executeCommand',
      }),
      child('t1', 'tool-call-approval', { toolCallId: 'child-command' }),
      lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs + 1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it('a terminal that outruns the dispatch acknowledgement never leaves a hold open', async () => {
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
      // A new manager subscriber is re-told every task it still lists as running.
      lifecycle('background-task-running', 't1')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs + 1);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it('a live-resumed child holds the leg again before its first part arrives', async () => {
    const leg = watchLeg(createWatch(true));
    await leg.push(
      ...dispatchingTurn('t1'),
      lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' }),
      lifecycle('background-task-resumed', 't1')
    );
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(leg.stall()).toBeUndefined();
    leg.finish();
    await leg.drained;
  });

  it("an orphan task's lifecycle never widens the parent's own window", async () => {
    // `running` is the manager's announcement, re-told to every new subscriber
    // and published for work this stream never dispatched: it holds nothing.
    const leg = watchLeg(createWatch(true));
    await leg.push(
      root('start'),
      root('step-start'),
      root('text-delta', { text: 'The parent answers.' }),
      lifecycle('background-task-running', 'orphan')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      lastPartType: 'background-task-running',
      phase: 'streaming',
    });
  });

  it('a watch over work this leg does not hold never suspends its judgment', async () => {
    // The child watchdogs follow every task of the scope; only the ones this
    // stream holds may suspend the parent's window.
    const leg = watchLeg(createWatch(new Set(['orphan'])));
    await leg.push(...dispatchingTurn('t1'), lifecycle('background-task-running', 'orphan'));
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(leg.stall()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
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
    // …and it is still the parent's own first-output wait, not a wider one.
    await vi.advanceTimersByTimeAsync(500);
    await leg.drained;
    expect(leg.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
  });
});
