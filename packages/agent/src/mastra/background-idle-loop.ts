import { createLogger } from '@brainstrike/logging';
import type { Agent } from '@mastra/core/agent';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import { MAX_BACKGROUND_TASK_TIMEOUT_MS } from '../pglite-mastra-memory/background-store';
import {
  type LiveBackgroundOwner,
  type LiveDecisionChannel,
  LiveDecisionUnavailableError,
} from './live-decision-channel';
import type { BrainstrikeAgentStreamOptions } from './runtime-assembly/stream-options';
import { type AgentStreamOptions, readNativeStreamStatus } from './turn-attempts';

const logger = createLogger('BackgroundIdleLoop');

/**
 * Host-owned replacement for Mastra's `untilIdle` loop (BST-1723, settled
 * 2026-09-14).
 *
 * Mastra's loop counts `background-task-suspended` as a terminal and answers
 * it with a parent inference whose directive tells the model to "let the user
 * know they are waiting for explicit resume input". The production root
 * parroted that line for every suspended specialist and refused to compile
 * its report (thread-1dab3290). A child's suspension is an approval prompt the
 * HOST surfaces; the parent model is woken only by a returned result, a
 * failure or a cancellation, exactly as the resume path
 * (`createBackgroundResumeStream`) already does. Everything else mirrors
 * Mastra's loop: the leg's first turn is piped as-is, native lifecycle chunks
 * are forwarded so `projectBackgroundStream` folds them, one continuation runs
 * per batch of wakeups, and the combined stream closes once no task is running
 * and nothing is queued. A running task that stays silent past `maxIdleMs`
 * closes the stream with its work unfinished, which the projection reports.
 *
 * While it runs, the loop owns the leg's live decision channel: a decision
 * delivered into the leg reserves the parked tasks (which keeps the loop from
 * settling), resumes them in-process, and their later terminals wake the
 * parent exactly like any other. A task resumed this way may park AGAIN
 * (its next gated read), so its earlier terminal is forgotten on resume — a
 * second suspension is a new pause with a new card, never a seen duplicate.
 *
 * A turn that ends on the PARENT's own pause (its native status is
 * `suspended`) parks the run on the user: no wakeup ever runs a continuation
 * on a parked run. Run 6 of the live-app verifier (2026-09-15) had the root
 * pause on its canvas write with one child's wakeup still queued; the
 * continuation re-prompted the parked root, which proposed the write AGAIN,
 * and the thread carried two canvas cards, one orphaned for good. Children
 * still running keep the leg open until they return (their results land in
 * the parent's history, which the resumed leg reads); the leg then closes as
 * the pause it is.
 */

export const WAKING_TASK_EVENTS: ReadonlySet<string> = new Set([
  'background-task-completed',
  'background-task-failed',
  'background-task-cancelled',
]);

export const TERMINAL_TASK_EVENTS: ReadonlySet<string> = new Set([
  ...WAKING_TASK_EVENTS,
  'background-task-suspended',
]);

const STARTING_TASK_EVENTS = new Set([
  'background-task-started',
  'background-task-running',
  'background-task-resumed',
]);

export interface TaskEvent {
  readonly payload: {
    readonly taskId?: unknown;
    readonly toolCallId?: unknown;
    readonly toolName?: unknown;
    readonly suspendedAt?: unknown;
  };
  readonly type: string;
}

export function readTaskEvent(chunk: unknown): TaskEvent | undefined {
  if (typeof chunk !== 'object' || chunk === null) {
    return;
  }
  const { type, payload } = chunk as { type?: unknown; payload?: unknown };
  if (typeof type !== 'string' || !type.startsWith('background-task-')) {
    return;
  }
  return { payload: typeof payload === 'object' && payload !== null ? payload : {}, type };
}

export function readTaskId(event: TaskEvent): string | undefined {
  return typeof event.payload.taskId === 'string' ? event.payload.taskId : undefined;
}

/**
 * One suspension is delivered more than once (the manager's lifecycle
 * event and the parent turn's own copy of it, and a replay on resume), and
 * a task resumed in-process legitimately suspends AGAIN later. The two are
 * told apart by the stamp Mastra puts on every suspension: a repeat of the
 * stamp already handled for that task is the same pause, never a new one.
 * Treating the repeat as new emptied the loop's running set while the task
 * ran and closed the leg with unfinished child work (2026-09-15, run 5 of the
 * live-app verifier).
 */
export function createSuspensionLedger(): (event: TaskEvent, taskId: string) => boolean {
  const lastStamp = new Map<string, string>();
  return (event, taskId) => {
    if (event.type !== 'background-task-suspended') {
      return true;
    }
    const raw = event.payload.suspendedAt;
    const stamp =
      raw instanceof Date ? raw.toISOString() : typeof raw === 'string' ? raw : String(raw ?? '');
    if (lastStamp.get(taskId) === stamp) {
      return false;
    }
    lastStamp.set(taskId, stamp);
    return true;
  };
}

function describeInvocation(event: TaskEvent): string {
  const id = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : 'unknown';
  return typeof event.payload.toolName === 'string' ? `${id} (${event.payload.toolName})` : id;
}

/** The parent wakeup for a batch of returned, failed or cancelled invocations. */
export function describeBackgroundWakeup(events: readonly TaskEvent[]): string {
  return events
    .map((event) => {
      const invocation = describeInvocation(event);
      switch (event.type) {
        case 'background-task-completed':
          return `Background invocation ${invocation} has returned. Use its saved outcome; do not execute it again.`;
        case 'background-task-failed':
          return `Background invocation ${invocation} failed; its failure is in the conversation. Do not retry it unless the user asks.`;
        case 'background-task-cancelled':
          return `Background invocation ${invocation} was cancelled by the user and has no result. Do not call it again unless the user asks.`;
        default:
          throw new Error(`Background lifecycle ${event.type} is not a parent wakeup.`);
      }
    })
    .join(' ');
}

/**
 * A terminal that wakes the parent: a returned, failed or cancelled task. A
 * suspension never does, and neither does a "completed" chunk that Mastra
 * stamps with `suspendedAt` (its own loop reads that stamp the same way).
 */
export function isParentWakeup(event: TaskEvent): boolean {
  return WAKING_TASK_EVENTS.has(event.type) && event.payload.suspendedAt === undefined;
}

/** The leg's own ephemeral context messages, kept ahead of the wakeup. */
function readContextMessages(options: LegStreamOptions): readonly unknown[] {
  const context = (options as { context?: unknown }).context;
  if (context === undefined) {
    return [];
  }
  if (!Array.isArray(context)) {
    throw new Error('Stream context must be a message array before a background wakeup joins it.');
  }
  return context;
}

/** The options a leg built for its native call (`buildStreamOptions`). */
type LegStreamOptions = BrainstrikeAgentStreamOptions & { runId?: string; toolCallId?: string };

export interface BackgroundIdleLoopParams {
  readonly abortSignal?: AbortSignal | undefined;
  readonly agent: Agent;
  /** The leg's live decision channel; the loop owns it while it runs. */
  readonly channel?: LiveDecisionChannel | undefined;
  readonly manager: BackgroundTaskManager;
  /** Silence budget for running work before the stream closes unfinished. */
  readonly maxIdleMs?: number | undefined;
  /** The leg's own options; a continuation reuses them, as Mastra's loop does. */
  readonly options: LegStreamOptions;
  readonly scope: { readonly threadId: string; readonly resourceId: string };
}

/** Native and host streams differ only in chunk type; the loop reads them alike. */
interface ReadableChunks {
  getReader(): ReadableStreamDefaultReader<unknown>;
}

interface NativeOutput {
  readonly fullStream: ReadableChunks;
}

/**
 * Wrap a leg's first-turn output so `fullStream` spans the first turn plus
 * every host-driven continuation. Aggregate properties (`status`,
 * `messageList`, `getFullOutput()`) keep resolving against the first turn,
 * the same contract Mastra's `untilIdle` proxy exposes.
 */
export function withBackgroundIdleLoop<Output extends NativeOutput>(
  first: Output,
  params: BackgroundIdleLoopParams
): Output {
  const maxIdleMs = params.maxIdleMs ?? MAX_BACKGROUND_TASK_TIMEOUT_MS;
  const priorContext = readContextMessages(params.options);
  const running = new Set<string>();
  const settled = new Set<string>();
  const pending: TaskEvent[] = [];
  const seenTerminals = new Set<string>();
  const isNewSuspension = createSuspensionLedger();
  const loopAbort = new AbortController();
  let processing = true;
  let closed = false;
  /** The parent's own pause ended a turn: the run is parked on the user. */
  let parked = false;
  /** Pauses whose remembered-grant answer is still being decided. */
  let answering = 0;
  let releaseOwner: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let controller!: ReadableStreamDefaultController<unknown>;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearIdleTimer();
    releaseOwner?.();
    loopAbort.abort();
    try {
      controller.close();
    } catch {
      // Already errored or cancelled by the consumer.
    }
  };
  const fail = (error: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    clearIdleTimer();
    releaseOwner?.();
    loopAbort.abort();
    try {
      controller.error(error);
    } catch {
      // Already errored or cancelled by the consumer.
    }
  };
  const enqueue = (chunk: unknown): boolean => {
    if (closed) {
      return false;
    }
    try {
      controller.enqueue(chunk);
      return true;
    } catch {
      return false;
    }
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    if (closed || processing || running.size === 0 || (pending.length > 0 && !parked)) {
      return;
    }
    idleTimer = setTimeout(() => {
      logger.warn('Background work went silent; closing the parent stream unfinished', {
        code: 'background_idle_expired',
        maxIdleMs,
        runningTasks: [...running],
      });
      close();
    }, maxIdleMs);
  };
  const settle = () => {
    if (closed || processing || answering > 0) {
      return;
    }
    if (parked) {
      if (running.size > 0) {
        armIdleTimer();
        return;
      }
      if (pending.length > 0) {
        logger.info(
          'Parked parent leg closes; returned work waits in its history for the resumed leg',
          {
            code: 'background_parked_parent_wakeups_deferred',
            invocations: pending.map(describeInvocation),
          }
        );
      }
      close();
      return;
    }
    if (pending.length > 0) {
      void runContinuation();
      return;
    }
    if (running.size === 0) {
      close();
      return;
    }
    armIdleTimer();
  };
  const pipe = async (stream: ReadableChunks) => {
    const reader = stream.getReader();
    try {
      while (!loopAbort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        clearIdleTimer();
        if (!enqueue(value)) {
          return;
        }
        const event = readTaskEvent(value);
        const taskId = event ? readTaskId(event) : undefined;
        // A fast child's terminal can outrun the dispatch acknowledgement in the
        // piped turn; a settled task never re-enters the running set.
        if (event && taskId && STARTING_TASK_EVENTS.has(event.type) && !settled.has(taskId)) {
          running.add(taskId);
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  /** Pipe one parent turn; a turn that closes suspended parks the run on the user. */
  const pipeTurn = async (turn: NativeOutput) => {
    await pipe(turn.fullStream);
    if (readNativeStreamStatus(turn) === 'suspended') {
      parked = true;
    }
  };
  const runContinuation = async () => {
    processing = true;
    const batch = pending.splice(0, pending.length);
    try {
      const continuation = await params.agent.stream([], {
        ...params.options,
        _skipBgTaskWait: true,
        context: [...priorContext, { content: describeBackgroundWakeup(batch), role: 'user' }],
      } as AgentStreamOptions);
      await pipeTurn(continuation);
    } catch (error) {
      fail(error);
      return;
    } finally {
      processing = false;
    }
    settle();
  };
  /** Book-keep one manager event; `false` once the consumer is gone. */
  const observeManagerEvent = (value: unknown): boolean => {
    const event = readTaskEvent(value);
    const taskId = event ? readTaskId(event) : undefined;
    if (!(event && taskId)) {
      return true;
    }
    const terminalKey = TERMINAL_TASK_EVENTS.has(event.type)
      ? `${taskId}:${event.type}`
      : undefined;
    if (terminalKey && seenTerminals.has(terminalKey)) {
      return true;
    }
    if (!isNewSuspension(event, taskId)) {
      return true;
    }
    clearIdleTimer();
    if (!enqueue(value)) {
      return false;
    }
    trackTask(event, taskId, terminalKey);
    settle();
    return true;
  };
  const trackTask = (event: TaskEvent, taskId: string, terminalKey: string | undefined) => {
    if (STARTING_TASK_EVENTS.has(event.type)) {
      if (!settled.has(taskId)) {
        running.add(taskId);
      }
      return;
    }
    if (!terminalKey) {
      return;
    }
    seenTerminals.add(terminalKey);
    settled.add(taskId);
    running.delete(taskId);
    if (isParentWakeup(event)) {
      pending.push(event);
    }
    if (event.type === 'background-task-suspended' && params.channel) {
      // A remembered grant may answer this pause; the loop waits for that
      // answer (which reserves the task) before it could settle on the pause.
      answering += 1;
      void params.channel.suspended(taskId).finally(() => {
        answering -= 1;
        settle();
      });
    }
  };
  const owner: LiveBackgroundOwner = {
    publish: enqueue,
    reserve(tasks) {
      if (closed) {
        throw new LiveDecisionUnavailableError('The leg has settled.');
      }
      clearIdleTimer();
      for (const task of tasks) {
        running.add(task.id);
        settled.delete(task.id);
        for (const type of TERMINAL_TASK_EVENTS) {
          seenTerminals.delete(`${task.id}:${type}`);
        }
      }
      const release = (ids: readonly string[]) => {
        for (const id of ids) {
          running.delete(id);
        }
        settle();
      };
      return {
        release: () => release(tasks.map((task) => task.id)),
        async resume(resumes) {
          const failures: unknown[] = [];
          for (const { resumeData, task } of resumes) {
            try {
              await params.manager.resume(task.id, resumeData);
            } catch (error) {
              failures.push(error);
              release([task.id]);
            }
          }
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, 'Live background resume failed.');
          }
        },
      };
    },
  };
  const watch = async () => {
    const reader = params.manager
      .stream({
        abortSignal: loopAbort.signal,
        agentId: params.agent.id,
        resourceId: params.scope.resourceId,
        threadId: params.scope.threadId,
      })
      .getReader();
    try {
      while (!loopAbort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done || !observeManagerEvent(value)) {
          return;
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      reader.releaseLock();
    }
  };

  const combined = new ReadableStream<unknown>({
    cancel() {
      close();
    },
    start(streamController) {
      controller = streamController;
    },
  });
  params.abortSignal?.addEventListener('abort', close, { once: true });
  releaseOwner = params.channel?.own(owner);
  void watch();
  void (async () => {
    try {
      await pipeTurn(first);
    } catch (error) {
      fail(error);
      return;
    }
    processing = false;
    settle();
  })();

  return new Proxy(first, {
    get(target, property) {
      if (property === 'fullStream') {
        return combined;
      }
      // The target is the receiver: Mastra's output keeps private fields that a
      // proxy receiver cannot reach.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
