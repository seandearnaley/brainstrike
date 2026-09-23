/**
 * The resume leg's test harness: a native manager shaped like `@mastra/core`
 * 1.64 and a leg driven against it. Shared by `background-resume.spec.ts`
 * (the executor-registration lifecycle) and
 * `background-resume-terminal-wait.spec.ts` (the wait that owns the live seam).
 */
import type {
  BackgroundTask,
  BackgroundTaskManager,
  TaskContext,
} from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import type { MastraAgentRuntime } from '../../agent-runtime';
import type { BackgroundChildWatchdogs } from '../../background-child-watchdog';
import { createBackgroundResumeStream } from '../../background-resume';
import type { DelegatedWakeupRecord } from '../../delegated-conversation-binding';
import type { LiveDecisionChannel } from '../../live-decision-channel';
import type { BrainstrikeAgentStreamOptions } from '../../runtime-assembly/stream-options';

const SCOPE = { resourceId: 'resource-1', threadId: 'thread-1' } as const;
export const TOOL = 'agent-explore';

export type ToolExecute = (
  args: Record<string, unknown>,
  options: {
    readonly outputWriter?: (chunk: unknown) => Promise<void>;
    readonly suspend?: (data?: unknown) => Promise<void>;
  }
) => Promise<unknown>;

export type ToolMap = Record<string, { readonly execute: ToolExecute }>;

/** A delegation tool whose resumed child parks again on its next gated call once `gate` opens. */
export function parkingTool(gate: Promise<void> = Promise.resolve()): {
  readonly execute: ToolExecute;
} {
  return {
    execute: async (_args, options) => {
      await gate;
      await options.suspend?.({ reason: 'next gated read' });
      return;
    },
  };
}

export const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function until(condition: () => boolean): Promise<void> {
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
export function createNativeManager(
  behaviour: {
    /** Tasks a Stop cancels right after `resume` published, before Mastra ran them. */
    readonly cancelOnResume?: ReadonlySet<string>;
    /** Tasks `resume` refuses (e.g. no longer suspended). */
    readonly refuseResume?: ReadonlySet<string>;
    /**
     * Tasks whose SECOND concurrent resume Mastra refuses: the first call's
     * `handleResume` flipped the row to running before this one read it.
     */
    readonly refuseConcurrentResume?: ReadonlySet<string>;
  } = {}
) {
  const calls: string[] = [];
  const contexts = new Map<string, TaskContext>();
  const rows = new Map<string, BackgroundTask>();
  let push: (event: unknown) => void = () => {};
  /** The lifecycle stream is readable; a consumer that stops reading cancels it. */
  let live = false;
  let stamp = 0;
  let heldRead: { readonly gate: Promise<void>; readonly onRead: () => void } | undefined;
  /** Runs once, inside the next `resume`, before it reads the task's status. */
  let pendingBeforeResume: (() => Promise<void>) | undefined;
  const resumeCalls = new Map<string, number>();
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
    const row = rows.get(taskId);
    if (row?.status !== 'suspended') {
      return;
    }
    const context = contexts.get(taskId);
    if (!context) {
      calls.push(`no-executor:${taskId}`);
      publish('background-task-failed', update(taskId, 'failed'), {
        error: { message: `No executor registered for tool "${row.toolName}".` },
      });
      return;
    }
    const running = update(taskId, 'running');
    publish('background-task-resumed', running);
    calls.push(`execute:${taskId}`);
    // Mastra passes no writer here: the HOST gives the tool its `outputWriter`
    // (`prepareResumedExecutor`), which is the write path under test.
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
      const held = heldRead;
      heldRead = undefined;
      if (held) {
        held.onRead();
        await held.gate;
      }
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
      resumeCalls.set(taskId, (resumeCalls.get(taskId) ?? 0) + 1);
      if (behaviour.refuseConcurrentResume?.has(taskId) && (resumeCalls.get(taskId) ?? 0) > 1) {
        throw new Error("Cannot resume task in status 'running' (expected 'suspended')");
      }
      const hook = pendingBeforeResume;
      pendingBeforeResume = undefined;
      await hook?.();
      // Mastra reads the row AFTER its own awaits, so a task another caller
      // resumed meanwhile is refused here (`manager.resume`, 1.64).
      const status = rows.get(taskId)?.status;
      if (status !== 'suspended') {
        throw new Error(`Cannot resume task in status '${status}' (expected 'suspended')`);
      }
      if (behaviour.cancelOnResume?.has(taskId)) {
        cancel(taskId);
      }
      setTimeout(() => {
        // A rejected dispatch is recorded, never swallowed: it then reads as a
        // call in the assertion instead of an invisible unhandled rejection.
        dispatch(taskId, resumeData).catch((error: unknown) => {
          calls.push(
            `dispatch-failed:${taskId}:${error instanceof Error ? error.message : String(error)}`
          );
        });
      }, 0);
      return rows.get(taskId);
    },
    shutdown: async () => {
      calls.push('shutdown');
    },
    stream: (options: { readonly abortSignal?: AbortSignal }) =>
      new ReadableStream<unknown>({
        // The leg stops reading the moment it stops waiting, which CANCELS
        // this stream — its own abort then arrives on a closed controller.
        // Mastra closes inside a try/catch for exactly that (`stream`,
        // background-tasks 1.64); the fixture tracks the cancel rather than
        // swallowing the error, so a close it did not expect still fails.
        cancel() {
          live = false;
          push = () => {};
        },
        start(controller) {
          live = true;
          push = (event) => controller.enqueue(event);
          options.abortSignal?.addEventListener(
            'abort',
            () => {
              push = () => {};
              if (!live) {
                return;
              }
              live = false;
              controller.close();
            },
            { once: true }
          );
        },
      }),
  };
  const add = (taskId: string, toolName: string = TOOL): BackgroundTask => {
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
      toolName,
    };
    rows.set(taskId, task);
    return task;
  };
  /** Hold the next durable read (a ledger row); `onRead` runs the moment that read starts. */
  const holdNextRead = (onRead: () => void = () => {}): (() => void) => {
    const gate = Promise.withResolvers<void>();
    heldRead = { gate: gate.promise, onRead };
    return () => gate.resolve();
  };
  return {
    add,
    calls,
    cancel,
    holdNextRead,
    manager: manager as unknown as BackgroundTaskManager,
    setBeforeResume: (hook: () => Promise<void>) => {
      pendingBeforeResume = hook;
    },
  };
}

/**
 * A resume leg whose root run is parked (`listSuspendedRuns` finds it), so no
 * terminal wakes a parent inference: the leg always ends on the join branch.
 */
export function startLeg(params: {
  /** The root Stop (`options.abortSignal`). */
  readonly abortSignal?: AbortSignal;
  /** The host's per-call join (`hooks.afterToolCall`) a resumed executor runs before it settles. */
  readonly afterToolCall?: () => Promise<void>;
  /** Holds the FIRST registration's tool resolution, parking the leg inside `register`. */
  readonly holdFirstRegistration?: Promise<void>;
  /**
   * Holds every later registration — the ones a live decision makes. A
   * function is asked per registration (1 is the first live one), so a test
   * can order two registrations of the SAME task against each other.
   */
  readonly holdLiveRegistration?: Promise<void> | ((live: number) => Promise<void> | undefined);
  readonly channel?: LiveDecisionChannel | undefined;
  readonly manager: BackgroundTaskManager;
  /** The host's durable wakeup rows (`conversationBinding.recordWakeup`). */
  readonly recordWakeup?: (record: DelegatedWakeupRecord) => Promise<void>;
  readonly resumes: readonly BackgroundTask[];
  readonly tools: Promise<ToolMap>;
}) {
  let registrations = 0;
  const holdFor = (registration: number): Promise<void> | undefined => {
    if (registration === 1) {
      return params.holdFirstRegistration;
    }
    const hold = params.holdLiveRegistration;
    return typeof hold === 'function' ? hold(registration - 1) : hold;
  };
  /** What the leg's resumed executors asked their child watchdogs, in order. */
  const watches: string[] = [];
  const backgroundChildWatchdogs: BackgroundChildWatchdogs = {
    dispose: () => {},
    hostExecution: (task) => {
      // The dispatch address a stall of this execution is delivered to.
      watches.push(`watch:${task.taskId}:${task.runId}:${task.toolCallId}`);
      return {
        end: () => {
          watches.push(`end:${task.taskId}`);
        },
        observe: () => {
          watches.push(`observe:${task.taskId}`);
        },
      };
    },
    subscribe: () => () => {},
    watching: () => false,
  };
  const runtime = {
    agent: {
      getToolsForExecution: async () => {
        registrations += 1;
        await holdFor(registrations);
        return await params.tools;
      },
      id: 'root',
      listSuspendedRuns: async () => ({ runs: [{ runId: 'root-run' }] }),
      stream: () => {
        throw new Error('A parked root takes no parent inference.');
      },
    },
    backgroundChildWatchdogs,
    backgroundTaskManager: params.manager,
    conversationBinding: {
      // Migration 140: these executor-race rows all belong to the parked
      // root's one generation. Supplying the real required host capability
      // keeps this spec focused on registration, drain and terminal ordering.
      readBackgroundGeneration: async () => ({
        generationRunId: 'root-run',
        nativeRunIds: ['root-run'],
      }),
      ...(params.recordWakeup ? { recordWakeup: params.recordWakeup } : {}),
    },
    delegationToolPersonas: new Map<string, string>(),
    personasById: new Map<string, { label: string }>(),
  } as unknown as MastraAgentRuntime;
  // Only the inputs these rows exercise are built here. The capture belongs to
  // a path this spec does not drive, so it is passed explicitly absent rather
  // than cast away: a future required parameter must fail this file's type
  // check instead of being absorbed by the argument's own parameter type.
  const leg = createBackgroundResumeStream({
    attachParent: async () => {},
    channel: params.channel,
    delegationOutcomes: undefined,
    memory: {} as MastraMemory,
    options: {
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      ...(params.afterToolCall ? { hooks: { afterToolCall: params.afterToolCall } } : {}),
    } as BrainstrikeAgentStreamOptions,
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
  return { ended, leg, watches };
}
