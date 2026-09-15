import type {
  BackgroundTask,
  BackgroundTaskManager,
  TaskContext,
} from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import { describe, expect, it } from 'vitest';
import type { MastraAgentRuntime } from '../agent-runtime';
import { createBackgroundResumeStream } from '../background-resume';
import { createLiveDecisionChannel, type LiveDecisionChannel } from '../live-decision-channel';
import type { BrainstrikeAgentStreamOptions } from '../runtime-assembly/stream-options';

const SCOPE = { resourceId: 'resource-1', threadId: 'thread-1' } as const;
const TOOL = 'agent-explore';

type ToolExecute = (
  args: Record<string, unknown>,
  options: { readonly suspend?: (data?: unknown) => Promise<void> }
) => Promise<unknown>;

type ToolMap = Record<string, { readonly execute: ToolExecute }>;

/** A delegation tool whose resumed child parks again on its next gated call once `gate` opens. */
function parkingTool(gate: Promise<void> = Promise.resolve()): { readonly execute: ToolExecute } {
  return {
    execute: async (_args, options) => {
      await gate;
      await options.suspend?.({ reason: 'next gated read' });
      return;
    },
  };
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (condition()) {
      return;
    }
    await macrotask();
  }
  throw new Error('The awaited condition never held.');
}

/**
 * The native manager surface the resume leg drives, shaped like
 * `@mastra/core` 1.64: `resume` validates and publishes, and the executor is
 * looked up one storage hop LATER (`handleResume` → `run-attempt`,
 * `workflow-BZbspbFy.js:60-86`) — a task with no registered context fails
 * with "No executor registered"; a task cancelled meanwhile never runs
 * (`handleResume` returns early). Every call is recorded in order.
 */
function createNativeManager(
  behaviour: {
    /** Tasks a Stop cancels right after `resume` published, before Mastra ran them. */
    readonly cancelOnResume?: ReadonlySet<string>;
    /** Tasks `resume` refuses (e.g. no longer suspended). */
    readonly refuseResume?: ReadonlySet<string>;
  } = {}
) {
  const calls: string[] = [];
  const contexts = new Map<string, TaskContext>();
  const rows = new Map<string, BackgroundTask>();
  let push: (event: unknown) => void = () => {};
  let stamp = 0;
  const update = (taskId: string, status: BackgroundTask['status']): BackgroundTask => {
    const row = rows.get(taskId);
    if (!row) {
      throw new Error(`No fixture row for ${taskId}.`);
    }
    const next = { ...row, status };
    rows.set(taskId, next);
    return next;
  };
  const publish = (type: string, task: BackgroundTask, extra: Record<string, unknown> = {}) => {
    push({
      payload: {
        agentId: task.agentId,
        runId: task.runId,
        taskId: task.id,
        toolCallId: task.toolCallId,
        toolName: task.toolName,
        ...extra,
      },
      type,
    });
  };
  const cancel = (taskId: string) => {
    publish('background-task-cancelled', update(taskId, 'cancelled'), { completedAt: new Date() });
  };
  const dispatch = async (taskId: string, resumeData: unknown) => {
    if (rows.get(taskId)?.status !== 'suspended') {
      return;
    }
    const context = contexts.get(taskId);
    if (!context) {
      publish('background-task-failed', update(taskId, 'failed'), {
        error: { message: `No executor registered for tool "${TOOL}".` },
      });
      return;
    }
    const running = update(taskId, 'running');
    publish('background-task-resumed', running);
    calls.push(`execute:${taskId}`);
    await context.executor.execute(running.args, {
      resumeData,
      suspend: async () => {
        stamp += 1;
        publish('background-task-suspended', update(taskId, 'suspended'), {
          suspendedAt: new Date(stamp),
        });
      },
    });
  };
  const manager = {
    deregisterTaskContext: (taskId: string) => {
      calls.push(`deregister:${taskId}`);
      contexts.delete(taskId);
    },
    listTasks: async () => {
      const tasks = [...rows.values()];
      return { tasks, total: tasks.length };
    },
    registerTaskContext: (taskId: string, context: TaskContext) => {
      calls.push(`register:${taskId}`);
      contexts.set(taskId, context);
    },
    resume: async (taskId: string, resumeData: unknown) => {
      calls.push(`resume:${taskId}`);
      if (behaviour.refuseResume?.has(taskId)) {
        throw new Error("Cannot resume task in status 'cancelled' (expected 'suspended')");
      }
      if (behaviour.cancelOnResume?.has(taskId)) {
        cancel(taskId);
      }
      setTimeout(() => {
        void dispatch(taskId, resumeData);
      }, 0);
      return rows.get(taskId);
    },
    shutdown: async () => {
      calls.push('shutdown');
    },
    stream: (options: { readonly abortSignal?: AbortSignal }) =>
      new ReadableStream<unknown>({
        start(controller) {
          push = (event) => controller.enqueue(event);
          options.abortSignal?.addEventListener(
            'abort',
            () => {
              push = () => {};
              controller.close();
            },
            { once: true }
          );
        },
      }),
  };
  const add = (taskId: string): BackgroundTask => {
    const task: BackgroundTask = {
      agentId: 'root',
      args: { prompt: `find ${taskId}` },
      createdAt: new Date(0),
      id: taskId,
      maxRetries: 0,
      resourceId: SCOPE.resourceId,
      retryCount: 0,
      runId: 'root-run',
      status: 'suspended',
      suspendedAt: new Date(0),
      threadId: SCOPE.threadId,
      timeoutMs: 1000,
      toolCallId: `call-${taskId}`,
      toolName: TOOL,
    };
    rows.set(taskId, task);
    return task;
  };
  return { add, calls, manager: manager as unknown as BackgroundTaskManager };
}

/**
 * A resume leg whose root run is parked (`listSuspendedRuns` finds it), so no
 * terminal wakes a parent inference: the leg always ends on the join branch.
 */
function startLeg(params: {
  /** The host's per-call join (`hooks.afterToolCall`) a resumed executor runs before it settles. */
  readonly afterToolCall?: () => Promise<void>;
  readonly channel?: LiveDecisionChannel | undefined;
  readonly manager: BackgroundTaskManager;
  readonly resumes: readonly BackgroundTask[];
  readonly tools: Promise<ToolMap>;
}) {
  const runtime = {
    agent: {
      getToolsForExecution: () => params.tools,
      id: 'root',
      listSuspendedRuns: async () => ({ runs: [{ runId: 'root-run' }] }),
      stream: () => {
        throw new Error('A parked root takes no parent inference.');
      },
    },
    backgroundTaskManager: params.manager,
    delegationToolPersonas: new Map<string, string>(),
    personasById: new Map<string, { label: string }>(),
  } as unknown as MastraAgentRuntime;
  const leg = createBackgroundResumeStream({
    attachParent: async () => {},
    channel: params.channel,
    memory: {} as MastraMemory,
    options: (params.afterToolCall
      ? { hooks: { afterToolCall: params.afterToolCall } }
      : {}) as BrainstrikeAgentStreamOptions,
    resumes: params.resumes.map((task) => ({ resumeData: { approved: true }, task })),
    runtime,
  });
  const ended = (async (): Promise<{ readonly error: unknown }> => {
    const reader = leg.fullStream.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          return { error: undefined };
        }
      }
    } catch (error) {
      return { error };
    }
  })();
  return { ended, leg };
}

describe('createBackgroundResumeStream executor registration (BST-1749)', () => {
  it('registers every resumed executor before Mastra is asked to resume any task', async () => {
    // Mastra reads the task context when its workflow runs the task; a resume
    // issued before registration lands races that lookup and can fail the
    // task with "No executor registered".
    const tools = Promise.withResolvers<ToolMap>();
    const native = createNativeManager();
    const { ended, leg } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1'), native.add('t2')],
      tools: tools.promise,
    });
    try {
      await macrotask();
      await macrotask();
      expect(native.calls).toEqual([]);
    } finally {
      tools.resolve({ [TOOL]: parkingTool() });
    }
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
    expect(native.calls.slice(0, 4)).toEqual([
      'register:t1',
      'register:t2',
      'resume:t1',
      'resume:t2',
    ]);
  }, 2000);

  it('fails the leg before any resume when a resumed executor is unavailable', async () => {
    const native = createNativeManager();
    const { ended } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({}),
    });
    const { error } = await ended;
    expect(error).toMatchObject({ message: 'The original background executor is unavailable.' });
    expect(native.calls).toEqual([]);
  }, 2000);

  it('a live resume Mastra refuses joins nothing: the leg still closes as a pause and keeps no executor for it', async () => {
    const gate = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ refuseResume: new Set(['t2']) });
    const refused = native.add('t2');
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(gate.promise) }),
    });
    await until(() => native.calls.includes('resume:t1'));
    const owner = channel.owner;
    if (!owner) {
      throw new Error('The resume leg does not own its live decision channel.');
    }
    const reservation = owner.reserve([refused]);
    await expect(
      reservation.resume([{ resumeData: { approved: true }, task: refused }])
    ).rejects.toThrow("Cannot resume task in status 'cancelled'");
    gate.resolve();
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
    expect(native.calls).toContain('deregister:t2');
  }, 2000);

  it('a task cancelled before Mastra ran its resumed executor does not hang the join under a parked root', async () => {
    const native = createNativeManager({ cancelOnResume: new Set(['t1']) });
    const { ended, leg } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
    expect(native.calls).not.toContain('execute:t1');
  }, 2000);

  it('the pause branch still joins a resumed executor whose host join outlives its suspension', async () => {
    // A terminal settles the join only for an executor that never started;
    // a started one is joined through its own settle (after the host join).
    const hostJoin = Promise.withResolvers<void>();
    const native = createNativeManager();
    const { ended } = startLeg({
      afterToolCall: () => hostJoin.promise,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    await until(() => native.calls.includes('execute:t1'));
    await macrotask();
    await macrotask();
    expect(native.calls).not.toContain('shutdown');
    hostJoin.resolve();
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(native.calls).toContain('shutdown');
  }, 2000);
});
