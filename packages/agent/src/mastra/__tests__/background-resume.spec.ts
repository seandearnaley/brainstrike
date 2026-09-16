import type {
  BackgroundTask,
  BackgroundTaskManager,
  TaskContext,
} from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import { describe, expect, it } from 'vitest';
import type { MastraAgentRuntime } from '../agent-runtime';
import { createBackgroundResumeStream } from '../background-resume';
import {
  createLiveDecisionChannel,
  type LiveDecisionChannel,
  LiveDecisionUnavailableError,
} from '../live-decision-channel';
import type { BrainstrikeAgentStreamOptions } from '../runtime-assembly/stream-options';

const SCOPE = { resourceId: 'resource-1', threadId: 'thread-1' } as const;
const TOOL = 'agent-explore';

type ToolExecute = (
  args: Record<string, unknown>,
  options: {
    readonly outputWriter?: (chunk: unknown) => Promise<void>;
    readonly suspend?: (data?: unknown) => Promise<void>;
  }
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
    // (`registerResumedExecutor`), which is the write path under test.
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
function startLeg(params: {
  /** The root Stop (`options.abortSignal`). */
  readonly abortSignal?: AbortSignal;
  /** The host's per-call join (`hooks.afterToolCall`) a resumed executor runs before it settles. */
  readonly afterToolCall?: () => Promise<void>;
  /** Holds the FIRST registration's tool resolution, parking the leg inside `register`. */
  readonly holdFirstRegistration?: Promise<void>;
  /** Holds every later registration — the ones a live decision makes. */
  readonly holdLiveRegistration?: Promise<void>;
  readonly channel?: LiveDecisionChannel | undefined;
  readonly manager: BackgroundTaskManager;
  readonly resumes: readonly BackgroundTask[];
  readonly tools: Promise<ToolMap>;
}) {
  let registrations = 0;
  const runtime = {
    agent: {
      getToolsForExecution: async () => {
        registrations += 1;
        await (registrations === 1 ? params.holdFirstRegistration : params.holdLiveRegistration);
        return await params.tools;
      },
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
    // Mastra accepted both resumes, so both keep their context.
    expect(native.calls.filter((call) => call.startsWith('deregister'))).toEqual([]);
  }, 2000);

  it('owns the live decision seam before it registers its executors', async () => {
    // Registration awaits `getToolsForExecution`. The leg must already own the
    // seam by then: its first run event streams immediately, and a decision
    // delivered from then on — a live session grant answering a sibling parked
    // on an earlier leg — must reach this leg instead of queueing as
    // 'no-live-run' (desktop `delegated-sibling-grant.integration.test.ts`).
    const tools = Promise.withResolvers<ToolMap>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const sibling = native.add('t2');
    const { ended } = startLeg({
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: tools.promise,
    });
    try {
      await macrotask();
      // Registration is still pending, so ownership cannot wait on it.
      expect(native.calls).toEqual([]);
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg registered its executors before it owned the live seam.');
      }
      expect(() => owner.reserve([sibling]).release()).not.toThrow();
    } finally {
      tools.resolve({ [TOOL]: parkingTool() });
    }
    await expect(ended).resolves.toEqual({ error: undefined });
  }, 2000);

  it('fails the leg before any resume when a resumed executor is unavailable, keeping no context', async () => {
    // Siblings carry different delegation tools, so registration can fail on
    // the SECOND task: the first task's context is already registered and must
    // not outlive the leg that never resumed it.
    const native = createNativeManager();
    const { ended } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1'), native.add('t2', 'agent-review')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    const { error } = await ended;
    expect(error).toMatchObject({ message: 'The original background executor is unavailable.' });
    expect(native.calls).toEqual(['register:t1', 'deregister:t1']);
  }, 2000);

  it('deregisters the tail Mastra never resumed when a resume fails part-way through the leg', async () => {
    const native = createNativeManager({ refuseResume: new Set(['t1']) });
    const { ended } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1'), native.add('t2')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    const { error } = await ended;
    expect(error).toMatchObject({
      message: "Cannot resume task in status 'cancelled' (expected 'suspended')",
    });
    expect(native.calls).toEqual([
      'register:t1',
      'register:t2',
      'resume:t1',
      'deregister:t1',
      'deregister:t2',
    ]);
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

  it('keeps the context of a task another caller already resumed', async () => {
    // The leg owns the seam across its whole registration window, so a live
    // decision can register and resume a task this leg is about to resume.
    // Mastra then refuses the leg's duplicate resume — and that refusal must
    // NOT drop the context Mastra is about to look up for the running task.
    const channel = createLiveDecisionChannel();
    const running = Promise.withResolvers<void>();
    let live: Promise<void> | undefined;
    const native = createNativeManager();
    const duplicate = native.add('t1');
    native.setBeforeResume(async () => {
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      const reservation = owner.reserve([duplicate]);
      live = reservation.resume([{ resumeData: { approved: true }, task: duplicate }]);
      await live;
      // Mastra picks the task up: the leg's own resume then finds it running.
      await macrotask();
    });
    const { ended } = startLeg({
      channel,
      manager: native.manager,
      resumes: [duplicate],
      // The live-resumed child is still working when the leg's own resume runs.
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      const { error } = await ended;
      expect(error).toMatchObject({
        message: "Cannot resume task in status 'running' (expected 'suspended')",
      });
      await expect(live).resolves.toBeUndefined();
      expect(native.calls).not.toContain('deregister:t1');
      expect(native.calls).toContain('execute:t1');
    } finally {
      running.resolve();
    }
  }, 2000);

  it('never re-registers or deregisters a task a live decision already resumed', async () => {
    // The leg owns the seam across its whole registration window, so a live
    // decision can resume a task the leg has NOT reached yet. Registering that
    // task again would overwrite a running task's context, orphan the join the
    // reservation already pushed, and let the leg's own refusal deregister it.
    const registering = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const first = native.add('t1');
    const ahead = native.add('t2');
    const { ended, leg } = startLeg({
      channel,
      holdFirstRegistration: registering.promise,
      manager: native.manager,
      resumes: [first, ahead],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => channel.owner !== undefined);
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      // t2 is resumed and running while the leg still awaits t1's registration.
      await owner.reserve([ahead]).resume([{ resumeData: { approved: true }, task: ahead }]);
      await until(() => native.calls.includes('execute:t2'));
      registering.resolve();
      await until(() => native.calls.includes('resume:t1'));
      expect(native.calls).not.toContain('deregister:t2');
      expect(native.calls.filter((call) => call === 'register:t2')).toHaveLength(1);
    } finally {
      running.resolve();
    }
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
  }, 2000);

  it('shares one registration when a live decision resumes a task the leg also holds', async () => {
    // Single-flight: the leg's registration and the decision's are the SAME
    // one, so the context Mastra runs is never replaced and the join already
    // pushed is never orphaned. Its terminal still settles that join.
    const running = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const shared = native.add('t1');
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [shared],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      await owner.reserve([shared]).resume([{ resumeData: { approved: true }, task: shared }]);
      // The task is cancelled while its executor is still in flight.
      native.cancel('t1');
      await expect(ended).resolves.toEqual({ error: undefined });
      expect(leg.status).toBe('suspended');
      expect(native.calls.filter((call) => call === 'register:t1')).toHaveLength(1);
      expect(native.calls.filter((call) => call === 'resume:t1')).toHaveLength(1);
      expect(native.calls).not.toContain('deregister:t1');
    } finally {
      running.resolve();
    }
  }, 2000);

  it('keeps the context of a live resume that is in flight when the leg is stopped', async () => {
    // The leg releases the contexts Mastra never accepted when it ends. A
    // decision whose `manager.resume` is in flight at that moment is about to
    // be accepted, so its context must survive the release: dropping it makes
    // Mastra's own lookup fail with "No executor registered".
    const running = Promise.withResolvers<void>();
    const stop = new AbortController();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const sibling = native.add('t2');
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      // The root Stop tears the leg down while this resume is in flight.
      native.setBeforeResume(async () => {
        stop.abort(new Error('User stopped the root.'));
        await ended;
      });
      await owner.reserve([sibling]).resume([{ resumeData: { approved: true }, task: sibling }]);
      await until(() =>
        native.calls.some((call) => call === 'execute:t2' || call === 'no-executor:t2')
      );
      expect(native.calls).toContain('execute:t2');
      expect(native.calls).not.toContain('deregister:t2');
    } finally {
      running.resolve();
    }
  }, 2000);

  it('refuses a live registration that lands after the leg released its executors', async () => {
    // Same window, opposite order: nothing would drain a context registered
    // after the release, and the manager outlives the leg.
    const holding = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const stop = new AbortController();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const sibling = native.add('t2');
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      holdLiveRegistration: holding.promise,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      const refused = owner
        .reserve([sibling])
        .resume([{ resumeData: { approved: true }, task: sibling }]);
      await macrotask();
      stop.abort(new Error('User stopped the root.'));
      await expect(ended).resolves.toMatchObject({
        error: { message: 'User stopped the root.' },
      });
      holding.resolve();
      await expect(refused).rejects.toBeInstanceOf(LiveDecisionUnavailableError);
      // The shared manager is never touched: no registration to undo.
      expect(native.calls).not.toContain('resume:t2');
      expect(native.calls).not.toContain('register:t2');
      expect(native.calls).not.toContain('deregister:t2');
    } finally {
      holding.resolve();
      running.resolve();
    }
  }, 2000);

  it('never deregisters an accepted task when a held registration lands on a drained leg', async () => {
    // The `accepted` check runs BEFORE the registration's await, so the task
    // can be accepted during it. If the leg drains meanwhile, the landing
    // registration must not deregister a task Mastra accepted and is running.
    const holding = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const stop = new AbortController();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const shared = native.add('t1');
    // The decision enters `register` BEFORE the leg's own resume is accepted.
    native.setBeforeResume(async () => {
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      const live = owner
        .reserve([shared])
        .resume([{ resumeData: { approved: true }, task: shared }]);
      live.catch(() => undefined);
      await macrotask();
    });
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      holdLiveRegistration: holding.promise,
      manager: native.manager,
      resumes: [shared],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      stop.abort(new Error('User stopped the root.'));
      await expect(ended).resolves.toMatchObject({
        error: { message: 'User stopped the root.' },
      });
      holding.resolve();
      await macrotask();
      expect(native.calls).not.toContain('deregister:t1');
      expect(native.calls).not.toContain('no-executor:t1');
    } finally {
      holding.resolve();
      running.resolve();
    }
  }, 2000);

  it('keeps the context when a second concurrent resume is refused while the first is in flight', async () => {
    // A live decision can resume a task whose own `manager.resume` this leg
    // has in flight: the row is still suspended when the decision selects it.
    // The refused call must not drop the context the accepted one needs.
    const running = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ refuseConcurrentResume: new Set(['t1']) });
    const shared = native.add('t1');
    let live: Promise<void> | undefined;
    native.setBeforeResume(async () => {
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      live = owner.reserve([shared]).resume([{ resumeData: { approved: true }, task: shared }]);
      await expect(live).rejects.toThrow("Cannot resume task in status 'running'");
    });
    const { ended } = startLeg({
      channel,
      manager: native.manager,
      resumes: [shared],
      tools: Promise.resolve({ [TOOL]: parkingTool(running.promise) }),
    });
    try {
      await until(() =>
        native.calls.some((call) => call === 'execute:t1' || call === 'no-executor:t1')
      );
      expect(native.calls).toContain('execute:t1');
      expect(native.calls).not.toContain('deregister:t1');
      running.resolve();
      await expect(ended).resolves.toEqual({ error: undefined });
    } finally {
      running.resolve();
    }
  }, 2000);

  it('registers afresh when a parked task is resumed again in the same leg', async () => {
    // A terminal retires the task's registration, so the second resume is a
    // new execution with its own join: the leg cannot close while it runs.
    const sibling = Promise.withResolvers<void>();
    const secondRead = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const parked = native.add('t1');
    let runs = 0;
    const tool: { readonly execute: ToolExecute } = {
      execute: async (args, options) => {
        if (String(args['prompt']).endsWith('t2')) {
          await sibling.promise;
        } else {
          runs += 1;
          if (runs > 1) {
            await secondRead.promise;
          }
        }
        await options.suspend?.({ reason: 'next gated read' });
      },
    };
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [parked, native.add('t2')],
      tools: Promise.resolve({ [TOOL]: tool }),
    });
    try {
      // t1 parked again; t2 keeps the leg's wait open.
      await until(() => native.calls.filter((call) => call === 'execute:t1').length === 1);
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The leg does not own its live decision seam.');
      }
      await owner.reserve([parked]).resume([{ resumeData: { approved: true }, task: parked }]);
      await until(() => native.calls.filter((call) => call === 'execute:t1').length === 2);
      await macrotask();
      expect(native.calls).not.toContain('shutdown');
      secondRead.resolve();
      sibling.resolve();
      await expect(ended).resolves.toEqual({ error: undefined });
      expect(leg.status).toBe('suspended');
      expect(native.calls.filter((call) => call === 'register:t1')).toHaveLength(2);
    } finally {
      secondRead.resolve();
      sibling.resolve();
    }
  }, 2000);

  it('a resumed tool that writes after its leg closed does not throw into the execution', async () => {
    // A cancel settles the join while the executor is still in flight, so the
    // leg can close before the tool returns; its next write has nowhere to go
    // and must not fail the tool.
    const stuck = Promise.withResolvers<void>();
    let lateWrite: unknown = 'not attempted';
    const native = createNativeManager();
    const { ended } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({
        [TOOL]: {
          execute: async (_args, options) => {
            await stuck.promise;
            try {
              await options.outputWriter?.({ type: 'late-child-frame' });
              lateWrite = 'written';
            } catch (error) {
              lateWrite = error;
            }
          },
        },
      }),
    });
    await until(() => native.calls.includes('execute:t1'));
    native.cancel('t1');
    await expect(ended).resolves.toEqual({ error: undefined });
    stuck.resolve();
    await until(() => lateWrite !== 'not attempted');
    expect(lateWrite).toBe('written');
  }, 2000);

  it('a task cancelled while its resumed executor is still in flight settles the join', async () => {
    // Mastra publishes `task.cancelled` BEFORE the execution settles (it joins
    // that execution itself, under its 5s grace: `#joinTaskCancellation`), and
    // an in-flight `execute` settles only if the tool honours the abort signal
    // Mastra hands it. The leg's own join must not depend on that: the
    // terminal settles it, and `manager.shutdown()` performs the bounded join.
    const stuck = Promise.withResolvers<void>();
    const native = createNativeManager();
    const { ended, leg } = startLeg({
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({
        [TOOL]: {
          execute: async () => {
            await stuck.promise;
          },
        },
      }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      native.cancel('t1');
      await expect(ended).resolves.toEqual({ error: undefined });
      expect(leg.status).toBe('suspended');
      expect(native.calls).toContain('shutdown');
    } finally {
      stuck.resolve();
    }
  }, 2000);

  it('the pause branch still joins a resumed executor whose host join outlives its suspension', async () => {
    // Only a running executor parks, so a suspension never settles the join:
    // the executor that parked settles it, after its host join.
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

describe('createBackgroundResumeStream terminal wait (BST-1749)', () => {
  it('refuses a reservation once every awaited terminal is in, while the leg still joins its final ledger row', async () => {
    // The last terminal ends the wait and starts the leg's final ledger read
    // in the same turn. A decision that reaches `reserve` from then on — here
    // as that read starts, before the leg's own continuation runs — is refused
    // as not live (KNOWN LIMITS), never added to a wait that has ended.
    const channel = createLiveDecisionChannel();
    const native = createNativeManager({ cancelOnResume: new Set(['t1']) });
    const sibling = native.add('t2');
    let reservation: unknown;
    const release = native.holdNextRead(() => {
      try {
        channel.owner?.reserve([sibling]);
        reservation = 'accepted';
      } catch (error) {
        reservation = error;
      }
    });
    const { ended, leg } = startLeg({
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool() }),
    });
    await until(() => reservation !== undefined);
    release();
    expect(reservation).toBeInstanceOf(LiveDecisionUnavailableError);
    await expect(ended).resolves.toEqual({ error: undefined });
    expect(leg.status).toBe('suspended');
  }, 2000);

  it('refuses a reservation once a stopped leg stopped waiting, while it still joins its final ledger row', async () => {
    const stop = new AbortController();
    const gate = Promise.withResolvers<void>();
    const channel = createLiveDecisionChannel();
    const native = createNativeManager();
    const other = native.add('t9');
    const sibling = native.add('t2');
    const { ended } = startLeg({
      abortSignal: stop.signal,
      channel,
      manager: native.manager,
      resumes: [native.add('t1')],
      tools: Promise.resolve({ [TOOL]: parkingTool(gate.promise) }),
    });
    try {
      await until(() => native.calls.includes('execute:t1'));
      let reading = false;
      const release = native.holdNextRead(() => {
        reading = true;
      });
      // Another child's terminal starts a ledger read; the Stop then ends the
      // lifecycle stream while that row is still being joined.
      native.cancel(other.id);
      await until(() => reading);
      stop.abort(new Error('User stopped the root.'));
      await macrotask();
      await macrotask();
      const owner = channel.owner;
      if (!owner) {
        throw new Error('The stopped leg released its owner before its final ledger row.');
      }
      expect(() => owner.reserve([sibling])).toThrow(LiveDecisionUnavailableError);
      release();
      const { error } = await ended;
      expect(error).toMatchObject({ message: 'User stopped the root.' });
    } finally {
      gate.resolve();
    }
  }, 2000);
});
