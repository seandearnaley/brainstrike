import { DELEGATION_LIMITS } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { Agent } from '@mastra/core/agent';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import { wasBackgroundOutcomePresented } from './active-background-results-processor';
import {
  type BackgroundLedgerSource,
  createLedgerPublisher,
  describeBackgroundWakeup,
} from './background-ledger';
import type {
  DelegatedWakeupInvocation,
  DelegatedWakeupRecord,
} from './delegated-conversation-binding';
import {
  type LiveBackgroundOwner,
  type LiveDecisionChannel,
  LiveDecisionUnavailableError,
} from './live-decision-channel';
import type { BrainstrikeAgentStreamOptions } from './runtime-assembly/stream-options';
import type { DelegationOutcomeCapture } from './subagent-delegation';
import {
  type AgentStreamOptions,
  readNativeStreamStatus,
  settleNativeStream,
} from './turn-attempts';

const logger = createLogger('BackgroundIdleLoop');

/**
 * How long the parent waits on running children with NO chunk or manager
 * event before it closes. Deliberately independent of a child's task deadline.
 */
const DEFAULT_BACKGROUND_IDLE_MS = 300_000;

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
 *
 * A delegation REFUSED at start is not returned work (REJECTED ADMISSION IS
 * NO INVOCATION, settled 2026-09-15). Mastra runs the delegation hook inside
 * the background task it already created, so the refusal completes as a task
 * row; the leg's delegation outcome capture names it, and its terminal wakes
 * nothing. A leg woken for more invocations than one turn may admit FAILS:
 * the next wakeup would be one more parent inference on work that never ran
 * (the 2026-09-15 E2E ledger reached "1160 total: 1160 returned" and the root
 * made 2337 model calls before the test timed out).
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
    readonly runId?: unknown;
  };
  readonly type: string;
}

/**
 * The parent run that dispatched the task — the ledger's scope. Every
 * manager lifecycle event carries it; the parent turn's own
 * `background-task-started` acknowledgement does not (Mastra's
 * `BackgroundTaskStartedPayload`), so the loop learns it from the manager's
 * `running` event at the latest.
 */
export function readTaskRunId(event: TaskEvent): string | undefined {
  return typeof event.payload.runId === 'string' ? event.payload.runId : undefined;
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

/**
 * A terminal that wakes the parent: a returned, failed or cancelled task. A
 * suspension never does, and neither does a "completed" chunk that Mastra
 * stamps with `suspendedAt` (its own loop reads that stamp the same way).
 */
export function isParentWakeup(event: TaskEvent): boolean {
  return WAKING_TASK_EVENTS.has(event.type) && event.payload.suspendedAt === undefined;
}

/** A refused delegation still completes its task (BST-1751); its leg's capture names it. */
function isRejectedDelegation(
  event: TaskEvent,
  rejectedDelegations: BackgroundIdleLoopParams['rejectedDelegations']
): boolean {
  const toolCallId = event.payload.toolCallId;
  return (
    typeof toolCallId === 'string' &&
    rejectedDelegations?.rejected(toolCallId, readTaskRunId(event)) === true
  );
}

/** The deferral a parked parent leg records: the model is sent nothing. */
export const PARKED_PARENT_DEFERRED_DIRECTIVE =
  'Parked parent leg closed; returned work waits in its history for the resumed leg. No model-facing wakeup text was sent.';

const WAKEUP_OUTCOME_BY_EVENT: Readonly<
  Record<string, Exclude<DelegatedWakeupInvocation['outcome'], 'deferred' | 'late'>>
> = {
  'background-task-cancelled': 'cancelled',
  'background-task-completed': 'completed',
  'background-task-failed': 'failed',
};

/**
 * The durable counterpart of a parent wakeup (swarm diagnostics, migration
 * 139): one entry per terminal event the wakeup answers — the directive
 * itself is the ledger text. Only parent wakeups (`isParentWakeup`) reach
 * this; a deferral passes `'deferred'` because the parent took no wakeup.
 */
export function describeWakeupInvocations(
  events: readonly TaskEvent[],
  deferred?: 'deferred'
): DelegatedWakeupInvocation[] {
  return events.map((event) => {
    const outcome = deferred ?? WAKEUP_OUTCOME_BY_EVENT[event.type];
    if (!outcome) {
      throw new Error(`A ${event.type} event is not a parent wakeup.`);
    }
    return {
      outcome,
      taskId: readTaskId(event) ?? null,
      toolCallId: String(event.payload.toolCallId),
      toolName: typeof event.payload.toolName === 'string' ? event.payload.toolName : null,
    };
  });
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
  /** The durable ledger this leg's wakeups and status rows are built from. */
  readonly ledger: BackgroundLedgerSource;
  readonly manager: BackgroundTaskManager;
  /** Silence budget for running work before the stream closes unfinished. */
  readonly maxIdleMs?: number | undefined;
  /** The leg's own options; a continuation reuses them, as Mastra's loop does. */
  readonly options: LegStreamOptions;
  /**
   * Maps a native ROOT run this leg starts to its host leg (migration 140):
   * the leg's own turn is mapped by its caller, each continuation here. A
   * later approval/resume leg derives its generation from that mapping, so a
   * pause raised in a continuation is still traceable to this generation.
   */
  readonly recordNativeRootRun: (nativeRunId: string) => Promise<void>;
  /**
   * Debug-pack evidence (migration 139), the binding's `recordWakeup`: every
   * continuation's exact wakeup text is recorded before it streams, and a
   * parked leg's deferral is joined before the leg closes.
   */
  readonly recordWakeup?: ((record: DelegatedWakeupRecord) => Promise<void>) | undefined;
  /**
   * The capture the leg's delegation config records refusals in
   * (`buildStreamOptions`): a refused delegation's completed task wakes no parent.
   */
  readonly rejectedDelegations: Pick<DelegationOutcomeCapture, 'rejected'> | undefined;
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
 * A continuation THIS loop starts. Unlike the leg's first turn — which the
 * loop only wraps — the loop owns this one, so it must also be able to settle
 * it when it abandons it (`discardTurn`).
 */
type ParentContinuation = NativeOutput & {
  consumeStream(options?: { onError?: (error: unknown) => void }): Promise<void>;
};

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
  const maxIdleMs = params.maxIdleMs ?? DEFAULT_BACKGROUND_IDLE_MS;
  const priorContext = readContextMessages(params.options);
  const running = new Set<string>();
  const settled = new Set<string>();
  const pending: TaskEvent[] = [];
  const seenTerminals = new Set<string>();
  /**
   * Tasks whose terminal queued a parent wakeup. Persona delegations are the
   * only background-eligible tools, so one turn's `maxInvocations` bounds it.
   */
  const woken = new Set<string>();
  const isNewSuspension = createSuspensionLedger();
  const loopAbort = new AbortController();
  let processing = true;
  let parentSucceeded = false;
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
  /** Deferral records a parked leg makes before it closes; `settle` joins them. */
  let recording = 0;
  const recordDeferral = (deferred: readonly TaskEvent[]) => {
    logger.info(
      'Parked parent leg closes; returned work waits in its history for the resumed leg',
      {
        code: 'background_parked_parent_wakeups_deferred',
        invocations: deferred.map(describeInvocation),
      }
    );
    const record = params.recordWakeup;
    if (!record) {
      close();
      return;
    }
    // Debug-pack evidence joined like a ledger row: the leg closes only once
    // the deferral is durable. The binding resolves even when its write
    // fails (it logs); a rejection breaks that contract and fails the leg,
    // exactly as the awaited idle-loop record does.
    recording += 1;
    void record({
      directive: PARKED_PARENT_DEFERRED_DIRECTIVE,
      invocations: describeWakeupInvocations(deferred, 'deferred'),
      kind: 'deferred',
    }).then(
      () => {
        recording -= 1;
        settle();
      },
      (error: unknown) => {
        recording -= 1;
        fail(error);
      }
    );
  };
  const discardPresentedWakeups = () => {
    if (!parentSucceeded) {
      return;
    }
    // An active step may have consumed a terminal while this loop was piping it.
    // Do not start another inference for an outcome the model already received.
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const event = pending[index];
      const taskId = event ? readTaskId(event) : undefined;
      if (taskId && wasBackgroundOutcomePresented(params.options.inputProcessors, taskId)) {
        pending.splice(index, 1);
      }
    }
  };
  const settle = () => {
    // An in-flight ledger read is joined before the leg can close: a leg
    // settling right after the last terminal would otherwise close before
    // the final "4 of 4" row was enqueued, and reload would show "3 of 4".
    // A parked leg's deferral record is joined the same way.
    if (closed || processing || answering > 0 || publisher.inFlight > 0 || recording > 0) {
      return;
    }
    discardPresentedWakeups();
    if (parked) {
      if (running.size > 0) {
        armIdleTimer();
        return;
      }
      if (pending.length > 0) {
        recordDeferral(pending.splice(0, pending.length));
        return;
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
  /**
   * Parent run ids this leg OBSERVED. The ledger's scope is the GENERATION
   * (migration 140); these close the window before a freshly dispatched run is
   * mapped, they are not the identity — that would give every leg its own.
   */
  const runIds = new Set<string>();
  const publisher = createLedgerPublisher({
    enqueue,
    onSettled: () => settle(),
    source: params.ledger,
  });
  const publishLedger = () => {
    if (runIds.size > 0) {
      publisher.publish(runIds);
    }
  };
  const noteRun = (event: TaskEvent) => {
    const runId = readTaskRunId(event);
    if (runId !== undefined) {
      runIds.add(runId);
    }
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
        if (!(event && taskId)) {
          continue;
        }
        noteRun(event);
        // A fast child's terminal can outrun the dispatch acknowledgement in the
        // piped turn; a settled task never re-enters the running set.
        if (STARTING_TASK_EVENTS.has(event.type) && !settled.has(taskId)) {
          running.add(taskId);
        }
        publishLedger();
      }
    } finally {
      reader.releaseLock();
    }
  };
  /** Pipe one parent turn; a turn that closes suspended parks the run on the user. */
  const pipeTurn = async (turn: NativeOutput) => {
    parentSucceeded = false;
    await pipe(turn.fullStream);
    parentSucceeded = readNativeStreamStatus(turn) === 'success';
    if (readNativeStreamStatus(turn) === 'suspended') {
      parked = true;
    }
  };
  /**
   * A continuation this leg built but never read to its end: its mapping was
   * refused, or its pipe failed part-way. Mastra runs its cancel persistence
   * and snapshot DELETEs when that stream closes, so an abandoned one floats
   * them past the end of the turn and races the storage close (BST-1221).
   *
   * Settling it — not cancelling it — is the disposal that works:
   * `MastraModelOutput.fullStream` is a fresh evented VIEW on every access and
   * its `cancel` only detaches that view's listeners, while `consumeStream`
   * memoises the one pump of the base stream and resolves when it has closed.
   *
   * The leg fails FIRST, and that is also what bounds this join: `fail` errors
   * the stream its consumer is reading, the consumer disposes the abort context
   * this continuation was started with, and the continuation ends. The
   * settlement deadline is the backstop for a stream that ignores that abort.
   */
  const discardTurn = async (turn: ParentContinuation | undefined) => {
    if (!turn) {
      return;
    }
    await settleNativeStream(turn, {
      abort: (reason) => loopAbort.abort(reason),
      signal: loopAbort.signal,
    });
  };
  const runContinuation = async () => {
    processing = true;
    const batch = pending.splice(0, pending.length);
    /** Set while this leg owns a continuation stream it has not finished reading. */
    let abandoned: ParentContinuation | undefined;
    try {
      // The wakeup is the whole ledger from the DURABLE rows (WAKEUP LEDGER,
      // settled 2026-09-15), never the batch alone: a read failure fails the
      // continuation loudly rather than waking the model on a partial count.
      const ledger = await params.ledger.read(runIds);
      logger.info('Parent wakeup', {
        code: 'background_parent_wakeup',
        invocations: batch.map(describeInvocation),
        ...ledger.counts,
      });
      const directive = describeBackgroundWakeup(ledger);
      // Debug-pack evidence: the exact text the model is about to receive,
      // durable BEFORE the continuation streams.
      await params.recordWakeup?.({
        directive,
        invocations: describeWakeupInvocations(batch),
        kind: 'idle-loop',
      });
      const continuation = await params.agent.stream([], {
        ...params.options,
        _skipBgTaskWait: true,
        context: [...priorContext, { content: directive, role: 'user' }],
      } as AgentStreamOptions);
      abandoned = continuation;
      // A continuation is a NEW native run of the SAME generation (Mastra mints
      // its own ids). Map it before its chunks flow: a pause raised here opens
      // its approval leg from the user's click, and that leg derives its
      // generation from this mapping.
      await params.recordNativeRootRun(continuation.runId);
      await pipeTurn(continuation);
      abandoned = undefined;
    } catch (error) {
      fail(error);
      await discardTurn(abandoned);
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
    noteRun(event);
    if (STARTING_TASK_EVENTS.has(event.type)) {
      if (!settled.has(taskId)) {
        running.add(taskId);
      }
      publishLedger();
      return;
    }
    if (!terminalKey) {
      return;
    }
    seenTerminals.add(terminalKey);
    settled.add(taskId);
    running.delete(taskId);
    if (isParentWakeup(event) && !isRejectedDelegation(event, params.rejectedDelegations)) {
      woken.add(taskId);
      if (woken.size > DELEGATION_LIMITS.maxInvocations) {
        logger.error('Background work woke the parent for more invocations than one turn admits', {
          code: 'background_parent_wakeup_limit_exceeded',
          invocation: describeInvocation(event),
          limit: DELEGATION_LIMITS.maxInvocations,
          taskIds: [...woken],
        });
        fail(
          new Error(
            `Background work woke the parent for ${woken.size} invocations; one turn admits at most ${DELEGATION_LIMITS.maxInvocations}, so the leg stops instead of waking the parent again.`
          )
        );
        return;
      }
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
    publishLedger();
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
