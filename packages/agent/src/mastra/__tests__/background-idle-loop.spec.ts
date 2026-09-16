import type { Agent } from '@mastra/core/agent';
import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import { describe, expect, it, vi } from 'vitest';
import { withBackgroundIdleLoop } from '../background-idle-loop';
import { createBackgroundLedgerSource } from '../background-ledger';
import { createLiveDecisionChannel } from '../live-decision-channel';

/**
 * The host idle loop's running set is the ONLY thing that keeps a leg open
 * while background children work. Run 5 of the live-app verifier
 * (2026-09-15) closed a leg with a child still working: the child's one
 * suspension was delivered again after the child had been resumed in-process,
 * the loop treated the repeat as a new pause, emptied its running set and
 * closed; the projection then failed the leg ("Background stream ended with
 * unfinished child work") and the renderer never got that child's terminal.
 */
function lifecycle(type: string, taskId: string, extra: Record<string, unknown> = {}) {
  return { payload: { runId: 'root-run', taskId, toolCallId: `call-${taskId}`, ...extra }, type };
}

function fakeManager(events: unknown[], onResume: (taskId: string) => void) {
  let push: ((event: unknown) => void) | undefined;
  const tasks: BackgroundTask[] = [];
  const stream = new ReadableStream<unknown>({
    start(controller) {
      push = (event) => controller.enqueue(event);
      for (const event of events) {
        controller.enqueue(event);
      }
    },
  });
  const manager = {
    listTasks: async () => ({ tasks: [...tasks], total: tasks.length }),
    resume: async (taskId: string) => {
      onResume(taskId);
      return {} as BackgroundTask;
    },
    stream: () => stream,
  } as unknown as BackgroundTaskManager;
  /** Set a task's durable row; the ledger reads THESE, never the loop's sets. */
  const setTask = (taskId: string, status: BackgroundTask['status']) => {
    const index = tasks.findIndex((task) => task.id === taskId);
    const row = {
      agentId: 'root',
      args: { prompt: `find ${taskId}` },
      createdAt: new Date(0),
      id: taskId,
      maxRetries: 0,
      retryCount: 0,
      runId: 'root-run',
      status,
      timeoutMs: 1000,
      toolCallId: `call-${taskId}`,
      toolName: 'agent-explore',
    } as BackgroundTask;
    if (index < 0) {
      tasks.push(row);
    } else {
      tasks[index] = row;
    }
  };
  const ledger = createBackgroundLedgerSource({
    manager,
    personaLabel: () => 'Explorer',
    rejectedDelegations: undefined,
    resolveInvocation: undefined,
    scope: { resourceId: 'r', threadId: 't' },
  });
  return { ledger, manager, push: (event: unknown) => push?.(event), setTask };
}

const emptyTurn = { fullStream: new ReadableStream<unknown>({ start: (c) => c.close() }) };
const agent = { id: 'root', stream: async () => emptyTurn } as unknown as Agent;

/** A parent turn that emits `chunks` and closes with Mastra's synchronous `status`. */
function turn(status: 'success' | 'suspended', chunks: unknown[] = []) {
  return {
    fullStream: new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    status,
  };
}

/** Lifecycle chunk types only; the ledger's `run-event` rows are asserted separately. */
async function drain(reader: ReadableStreamDefaultReader<unknown>): Promise<string[]> {
  const types: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return types;
    }
    const type = (value as { type: string }).type;
    if (type !== 'run-event') {
      types.push(type);
    }
  }
}

/** The next non-ledger chunk. */
async function readLifecycle(reader: ReadableStreamDefaultReader<unknown>) {
  for (;;) {
    const result = await reader.read();
    if (result.done || (result.value as { type: string }).type !== 'run-event') {
      return result;
    }
  }
}

interface LedgerRow {
  event: { label: string; status: string; metadata: Record<string, unknown> };
  type: 'run-event';
}

function isLedgerRow(chunk: unknown): chunk is LedgerRow {
  return (chunk as { type: string }).type === 'run-event';
}

describe('withBackgroundIdleLoop', () => {
  it('ignores a repeated suspension of a resumed task and stays open until the task returns', async () => {
    const channel = createLiveDecisionChannel();
    const suspended = lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' });
    const { ledger, manager, push } = fakeManager(
      [lifecycle('background-task-started', 't1'), suspended],
      () => {
        push(lifecycle('background-task-resumed', 't1'));
        // The manager delivers the SAME suspension again after the resume.
        push(suspended);
      }
    );
    // The armed leg holds the pause open while its remembered-grant answer is
    // decided (`armLiveDecisions`); the loop cannot settle on the pause until
    // then. Explicit here rather than a microtask race with the settle.
    const deciding = Promise.withResolvers<void>();
    channel.arm({
      deliver: () => Promise.reject(new Error('unused')),
      suspended: () => deciding.promise,
    });
    const output = withBackgroundIdleLoop(emptyTurn, {
      agent,
      channel,
      ledger,
      manager,
      maxIdleMs: 60_000,
      options: {} as never,
      rejectedDelegations: undefined,
      scope: { resourceId: 'r', threadId: 't' },
    });
    const reader = output.fullStream.getReader();
    // started, suspended reach the consumer; the loop now has nothing running.
    await readLifecycle(reader);
    await readLifecycle(reader);
    const owner = channel.owner;
    if (!owner) {
      throw new Error('The loop must own the live decision channel while it runs.');
    }
    const reservation = owner.reserve([{ id: 't1' } as BackgroundTask]);
    deciding.resolve();
    await reservation.resume([
      { resumeData: { approved: true }, task: { id: 't1' } as BackgroundTask },
    ]);
    const resumed = await readLifecycle(reader);
    expect((resumed.value as { type: string }).type).toBe('background-task-resumed');
    // The repeated suspension is neither forwarded nor a reason to close: the
    // next chunk the consumer sees is the task's completion, on an open stream.
    let settled = false;
    const probe = readLifecycle(reader).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    push(lifecycle('background-task-completed', 't1'));
    const completed = await probe;
    expect(completed.done).toBe(false);
    expect((completed.value as { type: string }).type).toBe('background-task-completed');
  });

  it('treats a suspension with a NEW stamp as a new pause', async () => {
    const channel = createLiveDecisionChannel();
    const { ledger, manager, push } = fakeManager(
      [lifecycle('background-task-started', 't1')],
      () => {
        push(lifecycle('background-task-resumed', 't1'));
      }
    );
    const output = withBackgroundIdleLoop(emptyTurn, {
      agent,
      channel,
      ledger,
      manager,
      maxIdleMs: 60_000,
      options: {} as never,
      rejectedDelegations: undefined,
      scope: { resourceId: 'r', threadId: 't' },
    });
    const reader = output.fullStream.getReader();
    await readLifecycle(reader);
    push(lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' }));
    await readLifecycle(reader);
    const reservation = channel.owner?.reserve([{ id: 't1' } as BackgroundTask]);
    await reservation?.resume([{ resumeData: {}, task: { id: 't1' } as BackgroundTask }]);
    await readLifecycle(reader);
    push(lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-2' }));
    await readLifecycle(reader);
    // Nothing runs and nothing is pending: the loop closes on the second, real pause.
    const end = await readLifecycle(reader);
    expect(end.done).toBe(true);
  });

  // Run 6 of the live-app verifier (2026-09-15): the root paused on its OWN
  // gated canvas write while one child's wakeup was still queued; the loop
  // ran that wakeup as a continuation on top of the parked run, the root
  // proposed the write AGAIN, and the thread showed two canvas cards, one of
  // them orphaned forever. A parked parent is on the user: the leg ends.
  it("a turn that ends on the parent's own pause never starts a continuation; the leg closes once nothing runs", async () => {
    const channel = createLiveDecisionChannel();
    const { ledger, manager, push } = fakeManager([], () => {});
    const stream = vi.fn(async () => turn('success'));
    const output = withBackgroundIdleLoop(
      turn('suspended', [lifecycle('background-task-started', 't1')]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        channel,
        ledger,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        rejectedDelegations: undefined,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    await readLifecycle(reader);
    // The child returns AFTER the parent parked: its wakeup has no turn to join.
    push(lifecycle('background-task-completed', 't1'));
    expect(await drain(reader)).toEqual(['background-task-completed']);
    expect(stream).not.toHaveBeenCalled();
  });

  it('a turn that ends normally runs the queued wakeup as one continuation carrying the durable ledger', async () => {
    const channel = createLiveDecisionChannel();
    const { ledger, manager, push, setTask } = fakeManager([], () => {});
    setTask('t1', 'running');
    setTask('t2', 'running');
    const stream = vi.fn(async () => turn('success'));
    const output = withBackgroundIdleLoop(
      turn('success', [
        lifecycle('background-task-started', 't1'),
        lifecycle('background-task-started', 't2'),
      ]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        channel,
        ledger,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        rejectedDelegations: undefined,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    await readLifecycle(reader);
    await readLifecycle(reader);
    setTask('t1', 'completed');
    push(lifecycle('background-task-completed', 't1'));
    // The first wakeup: one returned, one still running — no closing sentence.
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    const firstContext = JSON.stringify(
      (stream.mock.calls[0] as unknown as [unknown, { context: unknown[] }])[1].context
    );
    expect(firstContext).toContain('2 total: 1 returned, 0 failed, 0 cancelled, 1 still running');
    expect(firstContext).toContain('call-t1 (agent-explore, Explorer): returned');
    expect(firstContext).toContain('call-t2 (agent-explore, Explorer): still running');
    expect(firstContext).not.toContain('Nothing is still running');
    setTask('t2', 'failed');
    const failed = lifecycle('background-task-failed', 't2');
    push({ ...failed, payload: { ...failed.payload, error: { message: 'boom' } } });
    expect(await drain(reader)).toEqual(['background-task-completed', 'background-task-failed']);
    expect(stream).toHaveBeenCalledTimes(2);
    const secondContext = JSON.stringify(
      (stream.mock.calls[1] as unknown as [unknown, { context: unknown[] }])[1].context
    );
    // MUTATION: building the wakeup from the loop's in-memory sets instead of
    // the durable rows cannot name the failure reason; omitting the closing
    // sentence reproduces the GLM root's "waiting on the remaining subagents".
    expect(secondContext).toContain(
      'All 2 background invocations have finished. Nothing is still running.'
    );
    expect(secondContext).toContain('call-t2 (agent-explore, Explorer): failed');
  });

  it('publishes a delegation.ledger row on every lifecycle change and the final row before closing', async () => {
    const channel = createLiveDecisionChannel();
    const { ledger, manager, push, setTask } = fakeManager([], () => {});
    setTask('t1', 'running');
    const output = withBackgroundIdleLoop(
      turn('success', [lifecycle('background-task-started', 't1')]),
      {
        agent,
        channel,
        ledger,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        rejectedDelegations: undefined,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    const chunks: unknown[] = [];
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        chunks.push(value);
      }
    })();
    await vi.waitFor(() => expect(chunks.filter(isLedgerRow)).toHaveLength(1));
    setTask('t1', 'completed');
    push(lifecycle('background-task-completed', 't1'));
    await reading;
    const rows = chunks
      .filter(isLedgerRow)
      .map((c) => [c.event.label, c.event.status, c.event.metadata['ledgerId']]);
    // MUTATION: publishing from the loop's in-memory sets instead of the
    // durable rows cannot produce the completed row (the fixture flips the
    // ROW, never the loop's bookkeeping).
    expect(rows).toEqual([
      ['0 of 1 specialist returned · 1 running', 'running', 'root-run'],
      ['1 of 1 specialist returned', 'completed', 'root-run'],
    ]);
  });

  it('a parked parent leg publishes the final ledger row before it closes', async () => {
    // Nothing keeps this leg open once the last child returns: the parent is
    // parked (no continuation runs) and nothing else is running, so `settle`
    // closes synchronously while the row's durable read is still in flight.
    // MUTATION: dropping `publisher.inFlight > 0` from `settle` closes the
    // stream before the "1 of 1" row is enqueued — reload would show
    // "0 of 1 · 1 running" under a parked root for good.
    const channel = createLiveDecisionChannel();
    const { ledger, manager, push, setTask } = fakeManager([], () => {});
    setTask('t1', 'running');
    const stream = vi.fn(async () => turn('success'));
    const output = withBackgroundIdleLoop(
      turn('suspended', [lifecycle('background-task-started', 't1')]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        channel,
        ledger,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        rejectedDelegations: undefined,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    const chunks: unknown[] = [];
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        chunks.push(value);
      }
    })();
    await vi.waitFor(() => expect(chunks.filter(isLedgerRow)).toHaveLength(1));
    setTask('t1', 'completed');
    push(lifecycle('background-task-completed', 't1'));
    await reading;
    expect(stream).not.toHaveBeenCalled();
    expect(chunks.filter(isLedgerRow).map((c) => [c.event.label, c.event.status])).toEqual([
      ['0 of 1 specialist returned · 1 running', 'running'],
      ['1 of 1 specialist returned', 'completed'],
    ]);
  });

  it('records the idle-loop wakeup — the exact ledger text the model receives — before the continuation streams', async () => {
    const channel = createLiveDecisionChannel();
    const { ledger, manager, push, setTask } = fakeManager([], () => {});
    setTask('t1', 'running');
    const order: string[] = [];
    const wakeups: unknown[] = [];
    const stream = vi.fn(async () => {
      order.push('stream');
      return turn('success');
    });
    const output = withBackgroundIdleLoop(
      turn('success', [lifecycle('background-task-started', 't1', { toolName: 'agent-explore' })]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        channel,
        ledger,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        recordWakeup: async (record) => {
          order.push('record');
          wakeups.push(record);
        },
        rejectedDelegations: undefined,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    await readLifecycle(reader);
    setTask('t1', 'completed');
    push(lifecycle('background-task-completed', 't1', { toolName: 'agent-explore' }));
    expect(await drain(reader)).toEqual(['background-task-completed']);
    const context = (
      stream.mock.calls[0] as unknown as [unknown, { context: { content: string }[] }]
    )[1].context;
    const sent = context.at(-1)?.content;
    expect(sent).toContain('Nothing is still running');
    expect(wakeups).toEqual([
      {
        directive: sent,
        invocations: [
          { outcome: 'completed', taskId: 't1', toolCallId: 'call-t1', toolName: 'agent-explore' },
        ],
        kind: 'idle-loop',
      },
    ]);
    // MUTATION: recording after `pipeTurn(continuation)` reads ['stream', 'record'].
    expect(order).toEqual(['record', 'stream']);
  });

  it('a parked parent leg records its deferred wakeup and stays open until the record lands', async () => {
    const channel = createLiveDecisionChannel();
    const { ledger, manager, push, setTask } = fakeManager([], () => {});
    setTask('t1', 'running');
    const stream = vi.fn(async () => turn('success'));
    const landed = Promise.withResolvers<void>();
    const wakeups: unknown[] = [];
    const output = withBackgroundIdleLoop(
      turn('suspended', [
        lifecycle('background-task-started', 't1', { toolName: 'agent-explore' }),
      ]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        channel,
        ledger,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        recordWakeup: async (record) => {
          wakeups.push(record);
          await landed.promise;
        },
        rejectedDelegations: undefined,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    await readLifecycle(reader);
    setTask('t1', 'completed');
    push(lifecycle('background-task-completed', 't1', { toolName: 'agent-explore' }));
    expect(((await readLifecycle(reader)).value as { type: string }).type).toBe(
      'background-task-completed'
    );
    await vi.waitFor(() => expect(wakeups).toHaveLength(1));
    // A late lifecycle copy for the settled task (the manager replays around
    // resumes) publishes a ledger row whose settle runs while the deferral
    // record is still in flight.
    push(lifecycle('background-task-running', 't1', { toolName: 'agent-explore' }));
    expect(((await readLifecycle(reader)).value as { type: string }).type).toBe(
      'background-task-running'
    );
    let closed = false;
    const end = readLifecycle(reader).then((result) => {
      closed = result.done === true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // MUTATION: dropping `recording > 0` from `settle` lets that settle close the
    // leg here, before the deferral is durable (and a rejected record would then
    // be dropped by the closed leg instead of failing it).
    expect(closed).toBe(false);
    landed.resolve();
    expect((await end).done).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect(wakeups).toEqual([
      {
        directive:
          'Parked parent leg closed; returned work waits in its history for the resumed leg. No model-facing wakeup text was sent.',
        invocations: [
          { outcome: 'deferred', taskId: 't1', toolCallId: 'call-t1', toolName: 'agent-explore' },
        ],
        kind: 'deferred',
      },
    ]);
  });

  it('a delegation rejected at start wakes no parent turn and is no ledger entry', async () => {
    // BST-1751: Mastra answers a refusal inside the background task it already
    // created, so the rejected call still completes as a task row.
    const rejectedDelegations = {
      rejected: (toolCallId: string, runId?: string) =>
        toolCallId === 'call-t2' && runId === 'root-run',
    };
    const { manager, push, setTask } = fakeManager([], () => {});
    const ledger = createBackgroundLedgerSource({
      manager,
      personaLabel: () => 'Explorer',
      rejectedDelegations,
      resolveInvocation: undefined,
      scope: { resourceId: 'r', threadId: 't' },
    });
    setTask('t1', 'running');
    setTask('t2', 'running');
    const stream = vi.fn(async () => turn('success'));
    const output = withBackgroundIdleLoop(
      turn('success', [
        lifecycle('background-task-started', 't1'),
        lifecycle('background-task-started', 't2'),
      ]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        ledger,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        rejectedDelegations,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    const chunks: unknown[] = [];
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        chunks.push(value);
      }
    })();
    const lifecycleTypes = () =>
      chunks
        .filter((chunk) => !isLedgerRow(chunk))
        .map((chunk) => (chunk as { type: string }).type);
    await vi.waitFor(() => expect(lifecycleTypes()).toHaveLength(2));
    setTask('t2', 'completed');
    push(lifecycle('background-task-completed', 't2'));
    await vi.waitFor(() => expect(lifecycleTypes()).toHaveLength(3));
    setTask('t1', 'completed');
    push(lifecycle('background-task-completed', 't1'));
    await reading;
    // MUTATION: queueing the rejected terminal as a wakeup runs a second
    // continuation — one parent turn per refusal, as in the 2026-09-15 E2E.
    expect(stream).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(
      (stream.mock.calls[0] as unknown as [unknown, { context: unknown[] }])[1].context
    );
    // MUTATION: a ledger source that ignores the capture reads "2 total: 2 returned".
    expect(context).toContain('1 total: 1 returned, 0 failed, 0 cancelled, 0 still running');
    expect(context).not.toContain('call-t2');
    expect(chunks.filter(isLedgerRow).at(-1)?.event.label).toBe('1 of 1 specialist returned');
  });

  it('fails the leg loudly once more invocations wake the parent than one turn may admit', async () => {
    const { ledger, manager, push, setTask } = fakeManager([], () => {});
    let dispatched = 0;
    // Every parent turn dispatches a task that returns at once, as if
    // admission were bypassed; the script stops after 12 so an unbounded loop ends.
    const dispatchingTurn = () => {
      if (dispatched >= 12) {
        return turn('success');
      }
      dispatched += 1;
      const taskId = `t${dispatched}`;
      setTask(taskId, 'completed');
      push(lifecycle('background-task-completed', taskId));
      return turn('success', [lifecycle('background-task-started', taskId)]);
    };
    const stream = vi.fn(async () => dispatchingTurn());
    const output = withBackgroundIdleLoop(dispatchingTurn(), {
      agent: { id: 'root', stream } as unknown as Agent,
      ledger,
      manager,
      maxIdleMs: 60_000,
      options: {} as never,
      rejectedDelegations: undefined,
      scope: { resourceId: 'r', threadId: 't' },
    });
    // MUTATION: without the bound the leg wakes the parent for all 12 and closes cleanly.
    await expect(drain(output.fullStream.getReader())).rejects.toThrow(
      'Background work woke the parent for 9 invocations; one turn admits at most 8, so the leg stops'
    );
    expect(stream).toHaveBeenCalledTimes(8);
  });
});
