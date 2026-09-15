import type { Agent } from '@mastra/core/agent';
import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import { describe, expect, it, vi } from 'vitest';
import { withBackgroundIdleLoop } from '../background-idle-loop';
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
  const stream = new ReadableStream<unknown>({
    start(controller) {
      push = (event) => controller.enqueue(event);
      for (const event of events) {
        controller.enqueue(event);
      }
    },
  });
  const manager = {
    resume: async (taskId: string) => {
      onResume(taskId);
      return {} as BackgroundTask;
    },
    stream: () => stream,
  } as unknown as BackgroundTaskManager;
  return { manager, push: (event: unknown) => push?.(event) };
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

async function drain(reader: ReadableStreamDefaultReader<unknown>): Promise<string[]> {
  const types: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return types;
    }
    types.push((value as { type: string }).type);
  }
}

describe('withBackgroundIdleLoop', () => {
  it('ignores a repeated suspension of a resumed task and stays open until the task returns', async () => {
    const channel = createLiveDecisionChannel();
    const suspended = lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' });
    const { manager, push } = fakeManager(
      [lifecycle('background-task-started', 't1'), suspended],
      () => {
        push(lifecycle('background-task-resumed', 't1'));
        // The manager delivers the SAME suspension again after the resume.
        push(suspended);
      }
    );
    const output = withBackgroundIdleLoop(emptyTurn, {
      agent,
      channel,
      manager,
      maxIdleMs: 60_000,
      options: {} as never,
      scope: { resourceId: 'r', threadId: 't' },
    });
    const reader = output.fullStream.getReader();
    // started, suspended reach the consumer; the loop now has nothing running.
    await reader.read();
    await reader.read();
    const owner = channel.owner;
    if (!owner) {
      throw new Error('The loop must own the live decision channel while it runs.');
    }
    const reservation = owner.reserve([{ id: 't1' } as BackgroundTask]);
    await reservation.resume([
      { resumeData: { approved: true }, task: { id: 't1' } as BackgroundTask },
    ]);
    const resumed = await reader.read();
    expect((resumed.value as { type: string }).type).toBe('background-task-resumed');
    // The repeated suspension is neither forwarded nor a reason to close: the
    // next chunk the consumer sees is the task's completion, on an open stream.
    let settled = false;
    const probe = reader.read().then((result) => {
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
    const { manager, push } = fakeManager([lifecycle('background-task-started', 't1')], () => {
      push(lifecycle('background-task-resumed', 't1'));
    });
    const output = withBackgroundIdleLoop(emptyTurn, {
      agent,
      channel,
      manager,
      maxIdleMs: 60_000,
      options: {} as never,
      scope: { resourceId: 'r', threadId: 't' },
    });
    const reader = output.fullStream.getReader();
    await reader.read();
    push(lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-1' }));
    await reader.read();
    const reservation = channel.owner?.reserve([{ id: 't1' } as BackgroundTask]);
    await reservation?.resume([{ resumeData: {}, task: { id: 't1' } as BackgroundTask }]);
    await reader.read();
    push(lifecycle('background-task-suspended', 't1', { suspendedAt: 'stamp-2' }));
    await reader.read();
    // Nothing runs and nothing is pending: the loop closes on the second, real pause.
    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  // Run 6 of the live-app verifier (2026-09-15): the root paused on its OWN
  // gated canvas write while one child's wakeup was still queued; the loop
  // ran that wakeup as a continuation on top of the parked run, the root
  // proposed the write AGAIN, and the thread showed two canvas cards, one of
  // them orphaned forever. A parked parent is on the user: the leg ends.
  it("a turn that ends on the parent's own pause never starts a continuation; the leg closes once nothing runs", async () => {
    const channel = createLiveDecisionChannel();
    const { manager, push } = fakeManager([], () => {});
    const stream = vi.fn(async () => turn('success'));
    const output = withBackgroundIdleLoop(
      turn('suspended', [lifecycle('background-task-started', 't1')]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        channel,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    await reader.read();
    // The child returns AFTER the parent parked: its wakeup has no turn to join.
    push(lifecycle('background-task-completed', 't1'));
    expect(await drain(reader)).toEqual(['background-task-completed']);
    expect(stream).not.toHaveBeenCalled();
  });

  it('a turn that ends normally runs the queued wakeup as one continuation', async () => {
    const channel = createLiveDecisionChannel();
    const { manager, push } = fakeManager([], () => {});
    const stream = vi.fn(async () => turn('success'));
    const output = withBackgroundIdleLoop(
      turn('success', [lifecycle('background-task-started', 't1')]),
      {
        agent: { id: 'root', stream } as unknown as Agent,
        channel,
        manager,
        maxIdleMs: 60_000,
        options: {} as never,
        scope: { resourceId: 'r', threadId: 't' },
      }
    );
    const reader = output.fullStream.getReader();
    await reader.read();
    push(lifecycle('background-task-completed', 't1'));
    expect(await drain(reader)).toEqual(['background-task-completed']);
    expect(stream).toHaveBeenCalledTimes(1);
    const context = (stream.mock.calls[0] as unknown as [unknown, { context: unknown[] }])[1]
      .context;
    expect(JSON.stringify(context)).toContain('call-t1 has returned');
  });
});
