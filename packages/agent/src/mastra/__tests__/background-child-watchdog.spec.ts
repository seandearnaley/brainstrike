/**
 * Each BACKGROUND child's own stream under its own watchdog
 * (docs/agents/assistant-runtime.md, "Stream inactivity watchdog").
 *
 * The watchdogs follow the manager's lifecycle stream for the root agent's
 * scope: a task's execution is watched from `running`/`resumed` (or from the
 * start of an executor the host runs itself) until its child's stream ends,
 * it parks on a human, or the task reaches a terminal. Each child is judged by
 * the SAME phase windows the parent is, and a stall ends that child's
 * execution alone.
 *
 * Parts below are the real shapes: the manager's `background-task-*` events
 * and the delegation envelope Mastra's ToolStream writes a child's part in.
 */
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundChildStalledError,
  createBackgroundChildWatchdogs,
} from '../background-child-watchdog';

const WINDOWS = {
  firstOutputMs: 5000,
  interOutputMs: 1000,
  reasoningGapMs: 4000,
  toolExecutingMs: 9000,
} as const;

const SCOPE = { agentId: 'root', resourceId: 'owner', threadId: 'root-thread' } as const;

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

/** A child's own part inside its task's delegation envelope. */
const envelope = (taskId: string, type: string, payload: Record<string, unknown> = {}) => ({
  from: 'USER',
  payload: {
    output: { payload, runId: `child-run-${taskId}`, type },
    toolCallId: `call-${taskId}`,
    toolName: 'agent-explore',
  },
  runId: 'root-run',
  type: 'tool-output',
});

const output = (taskId: string, type: string, payload: Record<string, unknown> = {}) =>
  lifecycle('background-task-output', taskId, { payload: envelope(taskId, type, payload) });

function createManager() {
  let controller: ReadableStreamDefaultController<unknown> | undefined;
  const stream = vi.fn(
    (_options: Parameters<BackgroundTaskManager['stream']>[0]) =>
      new ReadableStream<unknown>({
        start(streamController) {
          controller = streamController;
        },
      })
  );
  return {
    async emit(...events: unknown[]) {
      for (const event of events) {
        controller?.enqueue(event);
      }
      await vi.advanceTimersByTimeAsync(0);
    },
    manager: { stream } as unknown as Pick<BackgroundTaskManager, 'stream'>,
    stream,
  };
}

function setup(delivered = true) {
  const native = createManager();
  const endExecution = vi.fn(
    (_target: { parentRuntimeRunId: string; parentToolCallId: string }, _stall: unknown) =>
      delivered
  );
  const watchdogs = createBackgroundChildWatchdogs({
    endExecution,
    guardedToolNames: new Set(['brainstrike_executeCommand']),
    manager: native.manager,
    scope: SCOPE,
    windows: WINDOWS,
  });
  return { endExecution, native, watchdogs };
}

/** Whether either fixture task is being watched. */
const watchingAny = (watchdogs: { watching(held: ReadonlySet<string>): boolean }) =>
  watchdogs.watching(new Set(['t1', 't2']));

function stallOf(endExecution: ReturnType<typeof setup>['endExecution'], call = 0) {
  const stall = endExecution.mock.calls[call]?.[1];
  if (!(stall instanceof BackgroundChildStalledError)) {
    throw new Error('Expected a BackgroundChildStalledError.');
  }
  return stall;
}

describe('each background child is judged by its own watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows the root agent's own scope from the moment it is created", () => {
    const { native, watchdogs } = setup();
    expect(native.stream).toHaveBeenCalledTimes(1);
    expect(native.stream.mock.calls[0]?.[0]).toMatchObject(SCOPE);
    expect(native.stream.mock.calls[0]?.[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    watchdogs.dispose();
    expect(native.stream.mock.calls[0]?.[0]?.abortSignal?.aborted).toBe(true);
  });

  it("a child's time-to-first-output rides the first-output window, and a stall there ends it", async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'start'),
      output('t1', 'step-start')
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(endExecution).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(endExecution).toHaveBeenCalledTimes(1);
    expect(endExecution.mock.calls[0]?.[0]).toEqual({
      parentRuntimeRunId: 'root-run',
      parentToolCallId: 'call-t1',
    });
    const stall = stallOf(endExecution);
    expect(stall).toMatchObject({
      code: 'background_child_stalled',
      inactivityMs: WINDOWS.firstOutputMs,
      lastPartType: 'step-start',
      partsSeen: 2,
      phase: 'awaiting-output',
    });
    expect(stall.message).toBe(
      'Subagent stalled: no output for 5000ms while waiting for its first output (its first-output window), so the host ended it.'
    );
    expect(watchingAny(watchdogs)).toBe(false);
    watchdogs.dispose();
  });

  it("a child's reasoning gap rides the reasoning window", async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'start'),
      output('t1', 'step-start'),
      output('t1', 'reasoning-delta', { text: 'thinking' })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.reasoningGapMs - 500);
    expect(endExecution).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(stallOf(endExecution)).toMatchObject({
      inactivityMs: WINDOWS.reasoningGapMs,
      message:
        'Subagent stalled: no output for 4000ms while reasoning (its reasoning-gap window), so the host ended it.',
      phase: 'reasoning',
    });
    watchdogs.dispose();
  });

  it('a child that stops mid-answer rides the inter-output window', async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'start'),
      output('t1', 'step-start'),
      output('t1', 'text-delta', { text: 'partial' })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    expect(stallOf(endExecution)).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      message:
        'Subagent stalled: no output for 1000ms while streaming its answer (its inter-output window), so the host ended it.',
      phase: 'streaming',
    });
    watchdogs.dispose();
  });

  it("a child's GUARDED tool call rides the tool-executing backstop", async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'start'),
      output('t1', 'step-start'),
      output('t1', 'tool-call', {
        toolCallId: 'child-command',
        toolName: 'brainstrike_executeCommand',
      })
    );
    // A silent build: longer than any provider window, inside the guard's.
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs + 1000);
    expect(endExecution).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WINDOWS.toolExecutingMs);
    expect(stallOf(endExecution)).toMatchObject({
      inactivityMs: WINDOWS.toolExecutingMs,
      message:
        'Subagent stalled: no output for 9000ms while a tool call was running (its tool-executing window), so the host ended it.',
      phase: 'tool-executing',
    });
    watchdogs.dispose();
  });

  it("an UNGUARDED child call stays on the child's provider windows", async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'start'),
      output('t1', 'step-start'),
      output('t1', 'tool-call', { toolCallId: 'child-memory', toolName: 'updateWorkingMemory' })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    expect(stallOf(endExecution)).toMatchObject({ phase: 'streaming' });
    watchdogs.dispose();
  });

  it('a delegation envelope that carries no part moves the phase without naming a part', async () => {
    const { endExecution, native, watchdogs } = setup();
    const empty = envelope('t1', 'unused');
    Reflect.deleteProperty(empty.payload, 'output');
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'text-delta', { text: 'partial' }),
      lifecycle('background-task-output', 't1', { payload: empty })
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    // The envelope is transport: it is never mistaken for a `tool-output` part.
    expect(stallOf(endExecution)).toMatchObject({
      lastPartType: 'text-delta',
      partsSeen: 2,
      phase: 'streaming',
    });
    watchdogs.dispose();
  });

  it('reports only the held tasks it watches', async () => {
    const { native, watchdogs } = setup();
    await native.emit(lifecycle('background-task-running', 't1'));
    expect(watchdogs.watching(new Set(['t1']))).toBe(true);
    expect(watchdogs.watching(new Set(['t2']))).toBe(false);
    expect(watchdogs.watching(new Set())).toBe(false);
    watchdogs.dispose();
  });

  it('a wedged child fails ALONE while its sibling keeps producing', async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      lifecycle('background-task-running', 't2'),
      output('t1', 'start'),
      output('t1', 'step-start'),
      output('t1', 'text-delta', { text: 'wedges here' }),
      output('t2', 'start'),
      output('t2', 'step-start'),
      output('t2', 'text-delta', { text: 'steady' })
    );
    for (let tick = 0; tick < 10; tick += 1) {
      await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs - 200);
      await native.emit(output('t2', 'text-delta', { text: 'steady' }));
    }
    expect(endExecution).toHaveBeenCalledTimes(1);
    expect(endExecution.mock.calls[0]?.[0]).toEqual({
      parentRuntimeRunId: 'root-run',
      parentToolCallId: 'call-t1',
    });
    // The sibling is still watched.
    expect(watchingAny(watchdogs)).toBe(true);
    watchdogs.dispose();
  });

  it("the child's own finish ends its watch: the terminal's persistence is not the child's silence", async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'start'),
      output('t1', 'text-delta', { text: 'done' }),
      output('t1', 'finish')
    );
    expect(watchingAny(watchdogs)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    // A late part of the same execution never re-arms it.
    await native.emit(output('t1', 'text-delta', { text: 'late' }));
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(endExecution).not.toHaveBeenCalled();
    watchdogs.dispose();
  });

  it.each(['tool-call-approval', 'tool-call-suspended'])(
    'a child that parks on a human (%s) is no longer judged',
    async (pause) => {
      const { endExecution, native, watchdogs } = setup();
      await native.emit(
        lifecycle('background-task-running', 't1'),
        output('t1', 'start'),
        output('t1', 'tool-call', {
          toolCallId: 'child-command',
          toolName: 'brainstrike_executeCommand',
        }),
        output('t1', pause, { toolCallId: 'child-command' })
      );
      expect(watchingAny(watchdogs)).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
      expect(endExecution).not.toHaveBeenCalled();
      watchdogs.dispose();
    }
  );

  it.each([
    'background-task-completed',
    'background-task-failed',
    'background-task-cancelled',
    'background-task-suspended',
  ])('a %s event ends the watch', async (terminal) => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(lifecycle('background-task-running', 't1'), output('t1', 'start'));
    await native.emit(lifecycle(terminal, 't1'));
    expect(watchingAny(watchdogs)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(endExecution).not.toHaveBeenCalled();
    watchdogs.dispose();
  });

  it('a resumed child is watched afresh from its resume', async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      output('t1', 'text-delta', { text: 'before the pause' }),
      output('t1', 'tool-call-approval', { toolCallId: 'child-read' }),
      lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' })
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await native.emit(lifecycle('background-task-resumed', 't1'));
    expect(watchingAny(watchdogs)).toBe(true);
    // A fresh execution waits on its first output, not the old `streaming` phase.
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 1);
    expect(endExecution).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stallOf(endExecution)).toMatchObject({ partsSeen: 0, phase: 'awaiting-output' });
    watchdogs.dispose();
  });

  it('a late or replayed `running` never re-arms an execution that already ended', async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(
      lifecycle('background-task-running', 't1'),
      lifecycle('background-task-completed', 't1'),
      lifecycle('background-task-running', 't1')
    );
    expect(watchingAny(watchdogs)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(endExecution).not.toHaveBeenCalled();
    watchdogs.dispose();
  });

  it('an execution the host runs itself is watched from its start to its end', async () => {
    const { endExecution, watchdogs } = setup();
    const execution = watchdogs.hostExecution({
      runId: 'root-run',
      taskId: 't1',
      toolCallId: 'call-t1',
    });
    expect(watchingAny(watchdogs)).toBe(true);
    execution.observe(envelope('t1', 'start'));
    execution.observe(envelope('t1', 'text-delta', { text: 'resumed work' }));
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs - 1);
    expect(endExecution).not.toHaveBeenCalled();
    execution.observe(envelope('t1', 'text-delta', { text: 'more' }));
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    expect(stallOf(endExecution)).toMatchObject({ phase: 'streaming' });
    expect(endExecution.mock.calls[0]?.[0]).toEqual({
      parentRuntimeRunId: 'root-run',
      parentToolCallId: 'call-t1',
    });
    execution.end();
    expect(watchingAny(watchdogs)).toBe(false);
    watchdogs.dispose();
  });

  it('an execution that ends normally is never judged afterwards', async () => {
    const { endExecution, watchdogs } = setup();
    const execution = watchdogs.hostExecution({
      runId: 'root-run',
      taskId: 't1',
      toolCallId: 'call-t1',
    });
    execution.observe(envelope('t1', 'text-delta', { text: 'answer' }));
    execution.end();
    expect(watchingAny(watchdogs)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(endExecution).not.toHaveBeenCalled();
    watchdogs.dispose();
  });

  it('a stall with no live execution to end stops watching it rather than judging it again', async () => {
    const { endExecution, native, watchdogs } = setup(false);
    await native.emit(lifecycle('background-task-running', 't1'));
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs);
    expect(endExecution).toHaveBeenCalledTimes(1);
    expect(watchingAny(watchdogs)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(endExecution).toHaveBeenCalledTimes(1);
    watchdogs.dispose();
  });

  it('announces every change in what it watches', async () => {
    const { native, watchdogs } = setup();
    let changes = 0;
    const count = async () => {
      while (true) {
        await watchdogs.changed();
        changes += 1;
      }
    };
    void count();
    await native.emit(lifecycle('background-task-running', 't1'));
    expect(changes).toBe(1);
    await native.emit(output('t1', 'finish'));
    expect(changes).toBe(2);
    watchdogs.dispose();
  });

  it('judges nothing after disposal', async () => {
    const { endExecution, native, watchdogs } = setup();
    await native.emit(lifecycle('background-task-running', 't1'), output('t1', 'start'));
    watchdogs.dispose();
    expect(watchingAny(watchdogs)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(endExecution).not.toHaveBeenCalled();
  });
});
