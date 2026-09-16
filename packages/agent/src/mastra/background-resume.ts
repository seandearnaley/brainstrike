import { createLogger } from '@brainstrike/logging';
import type {
  BackgroundTask,
  BackgroundTaskManager,
  TaskContext,
} from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import type { RuntimeData, StreamChunk } from '../types';
import type { attachAbortedTurnMessageList } from './aborted-turn-persistence';
import type { MastraAgentRuntime } from './agent-runtime';
import {
  type BackgroundIdleLoopParams,
  createSuspensionLedger,
  describeWakeupInvocations,
  isParentWakeup,
  readTaskEvent,
  readTaskId,
  type TaskEvent,
  TERMINAL_TASK_EVENTS,
  withBackgroundIdleLoop,
} from './background-idle-loop';
import {
  type BackgroundLedger,
  type BackgroundLedgerSource,
  createBackgroundLedgerSource,
  createLedgerPublisher,
  describeBackgroundWakeup,
  makeBackgroundLedgerChunk,
  personaLabelFor,
  requireBackgroundGeneration,
  requireNativeRootRunRecorder,
} from './background-ledger';
import { requireBackgroundResultDelivery } from './background-result-delivery';
import { saveBackgroundResult } from './background-results';
import {
  type LiveBackgroundOwner,
  type LiveDecisionChannel,
  LiveDecisionUnavailableError,
} from './live-decision-channel';
import type { BrainstrikeAgentStreamOptions } from './runtime-assembly/stream-options';
import type { DelegationOutcomeCapture } from './subagent-delegation';
import type { AgentStreamOptions } from './turn-attempts';

const logger = createLogger('BackgroundResume');

export async function findPendingBackgroundTask(
  manager: BackgroundTaskManager | undefined,
  memory: RuntimeData['memory'],
  action: { readonly runId: string; readonly toolCallId: string }
): Promise<BackgroundTask | undefined> {
  if (!manager) {
    return undefined;
  }
  if (!memory) {
    throw new Error('Background decisions require the original root memory scope.');
  }
  const { tasks } = await manager.listTasks({
    resourceId: memory.resourceId,
    runId: action.runId,
    threadId: memory.threadId,
  });
  const matches = tasks.filter((task) => task.toolCallId === action.toolCallId);
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1 || matches[0]?.status !== 'suspended') {
    throw new Error('The background decision is stale or ambiguous.');
  }
  return matches[0];
}

/** One parked task and the decision that resumes it. */
export interface BackgroundResume {
  readonly resumeData: unknown;
  readonly task: BackgroundTask;
}

/**
 * The set of resumed tasks whose terminals the leg waits for. A decision
 * delivered live during the wait adds its tasks; a failed record removes
 * them again. A suspension terminal is held until the leg's channel has had
 * its chance to answer it by a remembered grant. `onTerminal` hears every
 * terminal the wait records.
 */
function createTerminalWait(
  initial: Iterable<string>,
  channel: LiveDecisionChannel | undefined,
  onTerminal: (taskId: string, event: TaskEvent) => void
): {
  /** Wait for this task's terminal; `false` when the leg already awaited it. */
  readonly add: (taskId: string) => boolean;
  /** Stop accepting tasks (the leg stopped waiting). */
  readonly close: () => void;
  /**
   * No task may join any more: every terminal is in (set before `done`
   * resolves, so before the leg's own continuation runs) or the leg closed it.
   */
  readonly closed: () => boolean;
  readonly done: Promise<ReadonlyMap<string, TaskEvent>>;
  /** The terminals seen so far (the lifecycle stream may end before every one). */
  readonly seen: () => ReadonlyMap<string, TaskEvent>;
  readonly observe: (event: unknown) => void;
  readonly remove: (taskId: string) => void;
  readonly size: () => number;
} {
  const awaited = new Set(initial);
  const terminals = new Map<string, TaskEvent>();
  const done = Promise.withResolvers<ReadonlyMap<string, TaskEvent>>();
  const isNewSuspension = createSuspensionLedger();
  let answering = 0;
  let closed = false;
  const check = () => {
    if (answering === 0 && [...awaited].every((taskId) => terminals.has(taskId))) {
      closed = true;
      done.resolve(terminals);
    }
  };
  return {
    add: (taskId) => {
      if (awaited.has(taskId)) {
        return false;
      }
      awaited.add(taskId);
      return true;
    },
    close: () => {
      closed = true;
    },
    closed: () => closed,
    done: done.promise,
    observe: (event) => {
      const decoded = readTaskEvent(event);
      const taskId = decoded ? readTaskId(decoded) : undefined;
      if (!(decoded && taskId && awaited.has(taskId) && TERMINAL_TASK_EVENTS.has(decoded.type))) {
        return;
      }
      if (!isNewSuspension(decoded, taskId)) {
        return;
      }
      terminals.set(taskId, decoded);
      onTerminal(taskId, decoded);
      if (decoded.type === 'background-task-suspended' && channel) {
        answering += 1;
        void channel.suspended(taskId).finally(() => {
          answering -= 1;
          check();
        });
        return;
      }
      check();
    },
    remove: (taskId) => {
      awaited.delete(taskId);
      terminals.delete(taskId);
      check();
    },
    seen: () => terminals,
    size: () => awaited.size,
  };
}

/** The executors one resume leg registered, and the join for their executions. */
interface ResumedExecutors {
  /** Drop every context Mastra never accepted a resume for; nothing will run it. */
  readonly deregisterUnresumed: () => void;
  /** Join every execution the leg resumed (the pause branch's join). */
  readonly join: () => Promise<void>;
  /**
   * Register a task's executor with the manager. Awaited BEFORE Mastra is
   * asked to resume it: its workflow looks the executor up when it runs the
   * task, and fails a task it finds none for ("No executor registered").
   */
  readonly register: (task: BackgroundTask) => Promise<ResumedExecutor>;
  /** Register every task the leg resumes, before any of them is resumed. */
  readonly registerAll: (resumes: readonly BackgroundResume[]) => Promise<void>;
  /**
   * Resume a registered task. Only a task Mastra accepted joins the leg: a
   * refused resume would never run its executor, so it keeps no context and no
   * join. Mastra 1.64 throws from `resume` only BEFORE it publishes
   * `task.resume` (shutting down, missing or non-suspended task, concurrency
   * limit), so a refusal dispatched nothing — re-check on a Mastra upgrade.
   */
  readonly resume: (
    task: BackgroundTask,
    executor: ResumedExecutor,
    resumeData: unknown
  ) => Promise<void>;
  /** Resume every registered task, in the order the leg registered them. */
  readonly resumeAll: () => Promise<void>;
  /** Report a terminal the leg recorded for a task. */
  readonly terminal: (taskId: string, event: TaskEvent) => void;
}

/**
 * THE RESUMED-EXECUTOR LIFECYCLE (BST-1749, the #3207 reviews). Owning a task's
 * context IS the contract: Mastra looks the executor up when its workflow runs
 * the task, so a context dropped too early strands the child ("No executor
 * registered") and one dropped too late leaks on a manager that outlives this
 * leg. Every state below is per task, and concurrent callers are the norm — the
 * leg owns the live seam across its whole registration window, and
 * `findGrantedBackgroundApprovals` selects any row still `suspended`.
 *
 * REGISTERED  a context of this leg's is on the manager, no resume accepted yet
 * IN FLIGHT   `manager.resume` called and not returned (COUNTED: two callers
 *             can hold one task, and neither may clear the other's mark)
 * ACCEPTED    Mastra took some caller's resume; the task is running
 * DRAINED     the leg ended and released what Mastra never accepted
 *
 * | event \ state    | REGISTERED          | IN FLIGHT          | ACCEPTED           |
 * | resume accepted  | joins, leaves       | —                  | skipped: no second |
 * |                  | `unresumed`         |                    | `manager.resume`   |
 * | resume refused   | that call drops its | drops only if it   | keeps the context  |
 * |                  | own context         | is the last in     | (a concurrent call |
 * |                  |                     | flight             | won the race)      |
 * | leg drains       | drops the context   | skips: the in-     | keeps the context  |
 * |                  |                     | flight call drops  |                    |
 * |                  |                     | its own            |                    |
 * | register asked   | single-flight: the task's one live registration is       |
 * |                  | shared by every caller, so no context is ever replaced   |
 * |                  | and no join orphaned (drained: refused, manager          |
 * |                  | untouched — the registration is a thunk the leg calls    |
 * |                  | only once the tools have resolved AND it still may)      |
 * | terminal arrives | settles the task's executor and RETIRES both its         |
 * |                  | registration and its acceptance — acceptance is per      |
 * |                  | RESUME, so a child that parks again is registered and   |
 * |                  | resumed afresh, with its own join (a suspension settles  |
 * |                  | no executor: only a running one parks, and it settles    |
 * |                  | itself after its host join)                              |
 *
 * Pins, all in `background-resume.spec.ts`, by cell:
 * - register before resume: "registers every resumed executor before Mastra is
 *   asked to resume any task", "owns the live decision seam before it registers
 *   its executors", "fails the leg before any resume when a resumed executor is
 *   unavailable, keeping no context".
 * - register asked, single-flight: "shares one registration when a live decision
 *   resumes a task the leg also holds", "never re-registers or deregisters a
 *   task a live decision already resumed".
 * - register asked, drained: "refuses a live registration that lands after the
 *   leg released its executors" (in flight across the drain) and "refuses a
 *   reservation taken while the leg was live but used after the drain" (the
 *   cache hit, which the drain check above the lookup covers).
 * - resume refused: "deregisters the tail Mastra never resumed when a resume
 *   fails part-way through the leg", "a live resume Mastra refuses joins
 *   nothing: the leg still closes as a pause and keeps no executor for it",
 *   "keeps the context of a task another caller already resumed", "keeps the
 *   context when a second concurrent resume is refused while the first is in
 *   flight".
 * - leg drains: "keeps the context of a live resume that is in flight when the
 *   leg is stopped", "the drain keeps a context Mastra accepted while a live
 *   decision shared its registration".
 * - terminal arrives: "registers afresh when a parked task is resumed again in
 *   the same leg" (retiring the acceptance is what allows the second resume),
 *   "a task cancelled while its resumed executor is still in flight settles the
 *   join", "the pause branch still joins a resumed executor whose host join
 *   outlives its suspension".
 *
 * REGISTERED + terminal for a task the leg never resumed has no test and IS
 * reachable: the wait is seeded from the leg's own resumes at construction,
 * before any registration, so a tail the leg never got to resume is awaited all
 * the same. It is harmless — the terminal settles a join nobody pushed, and the
 * task stays in `unresumed` for the drain to deregister.
 *
 * Known-narrow, filed rather than guarded: a terminal that retires a
 * registration still in flight, and `wait.add` reporting `false` making the
 * give-back single-owner.
 */
function createResumedExecutors(params: {
  readonly controller: ReadableStreamDefaultController<unknown>;
  readonly manager: BackgroundTaskManager;
  readonly memory: MastraMemory;
  readonly onDeliveryError: (error: unknown) => void;
  readonly options: BrainstrikeAgentStreamOptions;
  readonly runtime: MastraAgentRuntime;
  readonly scope: { readonly resourceId: string; readonly threadId: string };
}): ResumedExecutors {
  /** The task's current executor; its terminal settles it and retires it. */
  const executors = new Map<string, ResumedExecutor>();
  /**
   * One registration per task at a time, shared by concurrent callers. A task
   * is registered once until its terminal retires it; a parked child resumed
   * again in this leg then registers afresh.
   */
  const registrations = new Map<string, Promise<ResumedExecutor>>();
  /** Registered contexts Mastra has not accepted a resume for. */
  const unresumed = new Set<string>();
  /** Tasks Mastra accepted a resume for — this leg's, or another caller's. */
  const accepted = new Set<string>();
  /**
   * Tasks whose resume is in flight. The leg's release leaves them alone: the
   * call is about to be accepted, and dropping its context would fail Mastra's
   * own lookup ("No executor registered"). Each releases its own context
   * instead, once it knows whether Mastra took it.
   */
  const resuming = new Map<string, number>();
  /** The leg released its registrations; nothing may hold one after that. */
  let drained = false;
  const settled: Promise<void>[] = [];
  /** The leg's own resumes, registered before any of them is resumed. */
  const registered: { readonly executor: ResumedExecutor; readonly resume: BackgroundResume }[] =
    [];
  const register = (task: BackgroundTask): Promise<ResumedExecutor> => {
    // Checked BEFORE the cache: a reservation taken while the leg was live but
    // used after the drain would otherwise be handed a resolved executor for a
    // context the drain has already deregistered, and its resume would reach
    // Mastra with nothing to look up.
    if (drained) {
      throw new LiveDecisionUnavailableError('The resume leg has released its executors.');
    }
    // Single-flight per task: whoever asks second shares the first
    // registration. A second `registerTaskContext` would replace the context
    // Mastra is about to run and orphan the join already pushed for the first.
    const existing = registrations.get(task.id);
    if (existing) {
      return existing;
    }
    const pending = (async () => {
      const commit = await prepareResumedExecutor({ ...params, task });
      // Resolving the tools was async: the leg may have released its
      // executors meanwhile, and nothing would ever drain a context
      // registered now — so the shared manager is left untouched.
      if (drained) {
        throw new LiveDecisionUnavailableError('The resume leg has released its executors.');
      }
      const executor = commit();
      executors.set(task.id, executor);
      // A registration that only LANDS after another caller's resume was
      // accepted must not re-arm the task: the leg would then deregister a
      // running task's context.
      if (!accepted.has(task.id)) {
        unresumed.add(task.id);
      }
      return executor;
    })();
    registrations.set(task.id, pending);
    pending.catch(() => {
      // A failed registration is not the task's registration.
      if (registrations.get(task.id) === pending) {
        registrations.delete(task.id);
      }
    });
    return pending;
  };
  const resume = async (
    task: BackgroundTask,
    executor: ResumedExecutor,
    resumeData: unknown
  ): Promise<void> => {
    // Another caller's accepted resume is this leg's too: that task is already
    // running and its join is already pushed, so asking Mastra again would
    // only be refused.
    if (accepted.has(task.id)) {
      return;
    }
    resuming.set(task.id, (resuming.get(task.id) ?? 0) + 1);
    try {
      await params.manager.resume(task.id, resumeData);
    } catch (error) {
      // Only a context this leg still owns is dropped. A task another caller
      // resumed meanwhile — a live decision reaching the seam during this
      // leg's registration window — is already running under the context
      // Mastra is about to look up, and a refusal here must not remove it.
      // Only when this is the ONLY resume in flight for the task: a concurrent
      // one may still be accepted, and it needs this context. This call's own
      // entry is still counted here — its `finally` runs after.
      if (!accepted.has(task.id) && resuming.get(task.id) === 1 && unresumed.delete(task.id)) {
        params.manager.deregisterTaskContext(task.id);
      }
      throw error;
    } finally {
      const inFlight = (resuming.get(task.id) ?? 1) - 1;
      if (inFlight > 0) {
        resuming.set(task.id, inFlight);
      } else {
        resuming.delete(task.id);
      }
    }
    unresumed.delete(task.id);
    accepted.add(task.id);
    settled.push(executor.executed);
  };
  return {
    deregisterUnresumed: () => {
      drained = true;
      for (const taskId of [...unresumed]) {
        // A resume in flight is about to be accepted or refused; it releases
        // its own context, so the leg leaves that one registered.
        if (resuming.has(taskId)) {
          continue;
        }
        // Never a task Mastra accepted: it runs under this context.
        if (!accepted.has(taskId)) {
          params.manager.deregisterTaskContext(taskId);
        }
        unresumed.delete(taskId);
      }
    },
    join: async () => {
      await Promise.all(settled);
    },
    register,
    registerAll: async (resumes) => {
      for (const entry of resumes) {
        registered.push({ executor: await register(entry.task), resume: entry });
      }
    },
    resume,
    resumeAll: async () => {
      for (const { executor, resume: entry } of registered) {
        await resume(entry.task, executor, entry.resumeData);
      }
    },
    terminal: (taskId, event) => {
      // The terminal retires the task's registration AND its acceptance:
      // acceptance is per resume, not per task, so a parked child resumed
      // again in this leg registers afresh and is resumed again, with its own
      // join. Keeping the acceptance would skip that second resume entirely.
      registrations.delete(taskId);
      accepted.delete(taskId);
      executors.get(taskId)?.terminal(event);
    },
  };
}

/**
 * The terminals that wake the parent — none when the ROOT is parked (its own
 * pause pending in this scope): a fresh parent inference would propose its
 * pending call again (two canvas cards, live-app verifier run 6). Its
 * returned results are saved; the root's own resume presents them (LATE
 * RESULTS AFTER A ROOT PAUSE).
 */
async function parentWakeups(
  agent: Pick<MastraAgentRuntime['agent'], 'listSuspendedRuns'>,
  scope: { readonly resourceId: string; readonly threadId: string },
  terminals: ReadonlyMap<string, TaskEvent>,
  recordWakeup: BackgroundIdleLoopParams['recordWakeup']
): Promise<TaskEvent[]> {
  const wakeups = [...terminals.values()].filter(isParentWakeup);
  if (wakeups.length === 0) {
    return wakeups;
  }
  const { runs } = await agent.listSuspendedRuns({
    resourceId: scope.resourceId,
    threadId: scope.threadId,
  });
  if (runs.length === 0) {
    return wakeups;
  }
  logger.info('Returned background work waits for the parked root to resume', {
    code: 'background_parent_parked_wakeup_deferred',
    invocations: wakeups.map((event) => String(event.payload.toolCallId)),
  });
  await recordWakeup?.({
    directive: PARKED_ROOT_DEFERRED_DIRECTIVE,
    invocations: describeWakeupInvocations(wakeups, 'deferred'),
    kind: 'deferred',
  });
  return [];
}

/** The deferral a resume leg records for a parked root: the model is sent nothing. */
const PARKED_ROOT_DEFERRED_DIRECTIVE =
  'Returned background work waits for the parked root to resume. No model-facing wakeup text was sent.';

function readResumeScope(resumes: readonly BackgroundResume[]): {
  readonly resourceId: string;
  readonly threadId: string;
} {
  const [primary] = resumes;
  if (!(primary?.task.threadId && primary.task.resourceId)) {
    throw new Error('Background resume has no native owner.');
  }
  const scope = { resourceId: primary.task.resourceId, threadId: primary.task.threadId };
  for (const { task } of resumes) {
    if (task.threadId !== scope.threadId || task.resourceId !== scope.resourceId) {
      throw new Error('Background resume spans more than one root scope.');
    }
  }
  return scope;
}

/**
 * The resume leg's ledger (WAKEUP LEDGER, settled 2026-09-15): the user's
 * `delegation.ledger` row on every terminal the leg observes and the parent's
 * wakeup, both read from the DURABLE task rows of the runs being resumed —
 * the same source the idle loop reads. `idle()` joins in-flight rows before
 * the leg releases its owner, so the final row is never lost to a fast close.
 */
function createResumeLedger(params: {
  readonly enqueue: (chunk: StreamChunk) => boolean;
  readonly manager: BackgroundTaskManager;
  readonly rejectedDelegations: DelegationOutcomeCapture | undefined;
  readonly resumes: readonly BackgroundResume[];
  readonly runtime: MastraAgentRuntime;
  readonly scope: { readonly resourceId: string; readonly threadId: string };
}): {
  readonly source: BackgroundLedgerSource;
  idle(): Promise<void>;
  observe(event: unknown): void;
  read(): Promise<BackgroundLedger>;
} {
  const [first] = params.resumes;
  if (!first) {
    throw new Error('Background resume has nothing to resume.');
  }
  const source = createBackgroundLedgerSource({
    generation: requireBackgroundGeneration(params.runtime.conversationBinding),
    manager: params.manager,
    personaLabel: personaLabelFor(params.runtime),
    rejectedDelegations: params.rejectedDelegations,
    // The resumed runs were dispatched by an EARLIER leg: only the host's
    // graph names a refusal among their rows.
    resolveInvocation: params.runtime.conversationBinding?.resolveParkedInvocation,
    scope: params.scope,
  });
  // The runs this leg OBSERVES. The ledger's scope is the whole GENERATION
  // (migration 140), so its row and the parent's wakeup cover what earlier
  // legs dispatched too — not just the run being resumed here.
  const runIds = new Set(params.resumes.map(({ task }) => task.runId));
  const publisher = createLedgerPublisher({ enqueue: params.enqueue, onSettled: () => {}, source });
  return {
    idle: () => publisher.idle(),
    observe: (event) => {
      if (TERMINAL_TASK_EVENTS.has(String((event as { type?: unknown }).type))) {
        publisher.publish(runIds);
      }
    },
    read: () => source.read(runIds),
    source,
  };
}

/**
 * Reconstruct the public native executor for every resumed task; consume
 * their events before parent inference. The first resume is the user's own
 * decision; the rest are parked siblings a session grant answered
 * (`findGrantedBackgroundApprovals`). The parent wakes ONCE, for every task
 * that returned; a task that parks on a new decision wakes nothing.
 */
export function createBackgroundResumeStream(params: {
  /** The leg's live decision channel; owned during the terminal wait. */
  readonly channel?: LiveDecisionChannel | undefined;
  /** The leg's delegation outcomes: a delegation its continuation refuses at start wakes nothing. */
  readonly delegationOutcomes: DelegationOutcomeCapture | undefined;
  readonly resumes: readonly BackgroundResume[];
  readonly runtime: MastraAgentRuntime;
  readonly memory: MastraMemory;
  readonly options: BrainstrikeAgentStreamOptions;
  readonly attachParent: (
    stream: Parameters<typeof attachAbortedTurnMessageList>[1]
  ) => Promise<void>;
}): {
  readonly fullStream: ReadableStream<unknown>;
  /**
   * The same synchronous status `MastraModelOutput` exposes: `suspended` when
   * every resumed task paused on a NEW decision, so the leg reading this
   * stream ends as a pause (`readNativeStreamStatus`), never as a missing
   * finish.
   */
  readonly status: 'running' | 'suspended' | 'success' | 'failed';
  /**
   * Joins everything `start()` below does — the background tasks' terminals,
   * the parent inference's full consumption and its snapshot cleanup — exactly
   * like `MastraModelOutput.consumeStream` (`settleNativeStream`). The stream's
   * own error reaches `onError`; without a handler it is swallowed, as Mastra's
   * does.
   */
  consumeStream(options?: { onError?: (error: unknown) => void }): Promise<void>;
  getFullOutput(): Promise<void>;
} {
  const completion = Promise.withResolvers<void>();
  // The consumer joins this promise at the native terminal; retain early failures.
  completion.promise.catch(() => {});
  let status: 'running' | 'suspended' | 'success' | 'failed' = 'running';
  const fullStream = new ReadableStream<unknown>({
    async start(controller) {
      const { resumes, runtime, memory, options } = params;
      const manager = runtime.backgroundTaskManager;
      const watching = new AbortController();
      let deliveryError: unknown;
      /** Drops the contexts Mastra never accepted, whatever ends the leg. */
      let deregisterUnresumed: (() => void) | undefined;
      try {
        if (!manager) {
          throw new Error('Background resume has no native owner.');
        }
        const scope = readResumeScope(resumes);
        const resumed = createResumedExecutors({
          controller,
          manager,
          memory,
          onDeliveryError: (error) => {
            deliveryError = error;
            watching.abort();
          },
          options,
          runtime,
          scope,
        });
        deregisterUnresumed = resumed.deregisterUnresumed;
        const events = manager.stream({
          abortSignal: options.abortSignal
            ? AbortSignal.any([watching.signal, options.abortSignal])
            : watching.signal,
          agentId: runtime.agent.id,
          resourceId: scope.resourceId,
          threadId: scope.threadId,
        });
        options.abortSignal?.throwIfAborted();
        const wait = createTerminalWait(
          resumes.map(({ task }) => task.id),
          params.channel,
          (taskId, event) => resumed.terminal(taskId, event)
        );
        // While the leg waits for terminals it owns the live decision seam: a
        // decision delivered now registers the parked task's executor exactly
        // as the leg's own resumes did, resumes it, and joins its terminal to
        // this same wait — one wakeup for everything that returned.
        let waiting = true;
        const owner: LiveBackgroundOwner = {
          publish: (chunk) => {
            if (!waiting) {
              return false;
            }
            controller.enqueue(chunk);
            return true;
          },
          reserve: (tasks) => {
            // An ended wait takes no task, even while the leg still joins its
            // final ledger row (KNOWN LIMITS: the decision is not live).
            if (wait.closed()) {
              throw new LiveDecisionUnavailableError('The resume leg is no longer waiting.');
            }
            // Only the tasks this reservation ADDED are its to give back: one
            // the leg is already waiting for stays awaited whatever becomes of
            // the decision, or the leg would stop observing its terminal.
            const added = new Set(tasks.filter((task) => wait.add(task.id)).map((task) => task.id));
            const giveBack = (taskId: string) => {
              if (added.delete(taskId)) {
                wait.remove(taskId);
              }
            };
            return {
              release: () => {
                for (const task of tasks) {
                  giveBack(task.id);
                }
              },
              resume: async (more) => {
                for (const { task, resumeData } of more) {
                  try {
                    await resumed.resume(task, await resumed.register(task), resumeData);
                  } catch (error) {
                    giveBack(task.id);
                    throw error;
                  }
                }
              },
            };
          },
        };
        const ledger = createResumeLedger({
          enqueue: owner.publish,
          manager,
          rejectedDelegations: params.delegationOutcomes,
          resumes,
          runtime,
          scope,
        });
        const releaseOwner = params.channel?.own(owner);
        let terminals: ReadonlyMap<string, TaskEvent>;
        try {
          // Registration is awaited before any resume — but only now that the
          // leg OWNS the live seam above. `getToolsForExecution` is async, and
          // the leg's first run event streams at once: a decision delivered
          // while it runs must reach this leg, not queue as 'no-live-run'.
          await resumed.registerAll(resumes);
          await resumed.resumeAll();
          const reading = (async () => {
            for await (const event of events) {
              controller.enqueue(event);
              wait.observe(event);
              ledger.observe(event);
              if (!waiting) {
                return;
              }
            }
          })();
          // The lifecycle stream ends early when result delivery fails
          // (`watching.abort()`); the checks below name that, never a hang.
          terminals = await Promise.race([wait.done, reading.then(() => wait.seen())]);
        } finally {
          // The wait takes no task once the leg stopped waiting (a Stop or a
          // failed resume ends it early); `publish` stays open meanwhile.
          wait.close();
          // Join in-flight ledger rows before the owner is released and the
          // publisher's enqueue closes: the final row must reach the leg.
          await ledger.idle();
          waiting = false;
          releaseOwner?.();
        }
        if (deliveryError !== undefined) {
          throw deliveryError;
        }
        options.abortSignal?.throwIfAborted();
        if (terminals.size !== wait.size()) {
          throw new Error('Background resume ended before every terminal task state.');
        }
        const wakeups = await parentWakeups(
          runtime.agent,
          scope,
          terminals,
          runtime.conversationBinding?.recordWakeup
        );
        if (wakeups.length === 0) {
          // A new decision is not a returned result, and a parked root takes no
          // wakeup (`parentWakeups`). Join the native snapshots before closing
          // this leg, without starting another parent inference; the leg reads
          // `status` to end as a pause.
          await resumed.join();
          await manager.shutdown();
          // The user's row still reflects the returned work, even though no
          // parent inference runs on this leg.
          controller.enqueue(makeBackgroundLedgerChunk(await ledger.read()));
          status = 'suspended';
          completion.resolve();
          controller.close();
          return;
        }
        watching.abort();
        // Native result injection above is joined before its terminal event.
        // The parent may dispatch further workers or see siblings return, so
        // its continuation runs under the same host loop as every other leg.
        const directive = describeBackgroundWakeup(await ledger.read());
        // Debug-pack evidence: the exact text the resumed parent receives,
        // durable BEFORE its inference streams.
        await runtime.conversationBinding?.recordWakeup?.({
          directive,
          invocations: describeWakeupInvocations(wakeups),
          kind: 'resume-leg',
        });
        const parent = withBackgroundIdleLoop(
          await runtime.agent.stream([], {
            ...options,
            context: [{ content: directive, role: 'user' }],
          } as AgentStreamOptions),
          {
            abortSignal: options.abortSignal,
            agent: runtime.agent,
            channel: params.channel,
            ledger: ledger.source,
            manager,
            maxIdleMs: runtime.backgroundIdleMs,
            options,
            recordNativeRootRun: requireNativeRootRunRecorder(runtime.conversationBinding),
            recordWakeup: runtime.conversationBinding?.recordWakeup,
            rejectedDelegations: params.delegationOutcomes,
            scope,
          }
        );
        await params.attachParent(parent);
        for await (const chunk of parent.fullStream) {
          controller.enqueue(chunk);
        }
        await parent.getFullOutput();
        status = 'success';
        completion.resolve();
        controller.close();
      } catch (error) {
        status = 'failed';
        completion.reject(error);
        controller.error(error);
      } finally {
        // A context Mastra never accepted — a registration or resume that
        // failed part-way through the leg's tasks, or an abort before the
        // resumes — must not outlive the leg: nothing will ever run it.
        deregisterUnresumed?.();
        watching.abort();
      }
    },
  });
  return {
    consumeStream: async (options) => {
      try {
        await completion.promise;
      } catch (error) {
        options?.onError?.(error);
      }
    },
    fullStream,
    getFullOutput: () => completion.promise,
    get status() {
      return status;
    },
  };
}

/** One resumed task's registered executor and the join for its execution. */
interface ResumedExecutor {
  /**
   * Settles once the executor settles (returned, threw or parked), after the
   * host join for its original dispatch address — or once Mastra published a
   * terminal that ends the task, which can arrive before the executor ever
   * started (cancelled before it ran) or while it is still in flight (a
   * cancel), neither of which the execution itself would settle.
   */
  readonly executed: Promise<void>;
  /**
   * A terminal the leg recorded for this task. Only a RUNNING executor parks
   * (Mastra passes `suspend` into `execute`), so a suspension is never this
   * registration's end and never settles it — the executor that parked settles
   * it after its host join. Every other terminal ends the task: completed,
   * failed and timed-out are published after the execution settled, and a
   * cancel is published before it, Mastra joining the aborted execution itself
   * under its shutdown grace exactly as this leg's `manager.shutdown()` does.
   */
  readonly terminal: (event: TaskEvent) => void;
}

/**
 * Prepare one task's in-process executor and result delivery. Resolving the
 * tools is async, so the REGISTRATION itself is handed back as a thunk: by the
 * time it resolves the task may already be running under another caller's
 * context, or the leg may have released its own, and neither may touch the
 * shared manager. Calling the thunk registers; `executed` joins the execution.
 */
async function prepareResumedExecutor(params: {
  readonly controller: ReadableStreamDefaultController<unknown>;
  readonly manager: BackgroundTaskManager;
  readonly memory: MastraMemory;
  readonly onDeliveryError: (error: unknown) => void;
  readonly options: BrainstrikeAgentStreamOptions;
  readonly runtime: MastraAgentRuntime;
  readonly scope: { readonly resourceId: string; readonly threadId: string };
  readonly task: BackgroundTask;
}): Promise<() => ResumedExecutor> {
  const { controller, manager, memory, options, runtime, scope, task } = params;
  const executed = Promise.withResolvers<void>();
  // The leg's stream can close before a resumed executor settles: a cancel
  // settles this task's join, and `manager.shutdown()` only bounds the wait
  // (Mastra's grace period), so a tool that runs past it would otherwise throw
  // "Controller is already closed" into its own execution. Its chunk has no
  // consumer left; the drop is reported once for the task.
  let closed = false;
  const publish = (chunk: unknown): void => {
    if (closed) {
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch (error) {
      closed = true;
      logger.warn('A resumed background executor wrote after its leg closed', {
        code: 'background_resume_output_after_close',
        error: error instanceof Error ? error.message : String(error),
        taskId: task.id,
        toolName: task.toolName,
      });
    }
  };
  const tools = await runtime.agent.getToolsForExecution({
    methodType: 'stream',
    resourceId: scope.resourceId,
    runId: task.runId,
    threadId: scope.threadId,
    ...(options.delegation ? { delegation: options.delegation } : {}),
    outputWriter: async (chunk: unknown) => {
      publish(chunk);
    },
  });
  const execute = tools[task.toolName]?.execute;
  if (!execute) {
    throw new Error('The original background executor is unavailable.');
  }
  const context: TaskContext = {
    executor: {
      execute: async (args, nativeOptions) => {
        let output: unknown;
        let failure: unknown;
        try {
          output = await execute(args, {
            messages: [],
            outputWriter: async (chunk: unknown) => {
              publish(chunk);
            },
            toolCallId: task.toolCallId,
            ...(nativeOptions?.abortSignal ? { abortSignal: nativeOptions.abortSignal } : {}),
            ...(nativeOptions?.resumeData === undefined
              ? {}
              : { resumeData: nativeOptions.resumeData }),
            ...(nativeOptions?.suspend ? { suspend: nativeOptions.suspend } : {}),
          });
          return output;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          // Native child resume mutates its invocation context to the leaf
          // call. The host join belongs to this original dispatch address.
          try {
            await options.hooks?.afterToolCall?.({
              context: { threadId: scope.threadId, toolCallId: task.toolCallId },
              input: args,
              output,
              toolName: task.toolName,
              ...(failure === undefined ? {} : { error: failure }),
            });
          } finally {
            executed.resolve();
          }
        }
      },
    },
    onResult: async (result) => {
      try {
        await saveBackgroundResult(memory, task, result);
        await requireBackgroundResultDelivery(await manager.getStorage()).markResultDelivered(
          task.id
        );
      } catch (error) {
        params.onDeliveryError(error);
        throw error;
      }
    },
  };
  return () => {
    manager.registerTaskContext(task.id, context);
    return {
      executed: executed.promise,
      terminal: (event) => {
        if (event.type !== 'background-task-suspended') {
          executed.resolve();
        }
      },
    };
  };
}
