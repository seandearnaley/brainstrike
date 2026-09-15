import { createLogger } from '@brainstrike/logging';
import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
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
  onTerminal: (taskId: string) => void
): {
  readonly add: (taskId: string) => void;
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
      awaited.add(taskId);
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
      onTerminal(taskId);
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
  readonly ledgerId: string;
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
    manager: params.manager,
    personaLabel: personaLabelFor(params.runtime),
    rejectedDelegations: params.rejectedDelegations,
    scope: params.scope,
  });
  const runIds = new Set(params.resumes.map(({ task }) => task.runId));
  const ledgerId = first.task.runId;
  const publisher = createLedgerPublisher({ enqueue: params.enqueue, onSettled: () => {}, source });
  return {
    idle: () => publisher.idle(),
    ledgerId,
    observe: (event) => {
      if (TERMINAL_TASK_EVENTS.has(String((event as { type?: unknown }).type))) {
        publisher.publish(runIds, ledgerId);
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
      const settled: Promise<void>[] = [];
      try {
        if (!manager) {
          throw new Error('Background resume has no native owner.');
        }
        const scope = readResumeScope(resumes);
        const executors = new Map<string, ResumedExecutor>();
        // Registration is awaited BEFORE Mastra is asked to resume: its
        // workflow looks the executor up when it runs the task, and fails a
        // task it finds none for ("No executor registered").
        const register = async (task: BackgroundTask): Promise<ResumedExecutor> => {
          const executor = await registerResumedExecutor({
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
            task,
          });
          executors.set(task.id, executor);
          return executor;
        };
        // Only a task Mastra accepted joins the leg: a refused resume would
        // never run its executor, so it keeps no context and no join.
        const resumeRegistered = async (
          task: BackgroundTask,
          executor: ResumedExecutor,
          resumeData: unknown
        ): Promise<void> => {
          try {
            await manager.resume(task.id, resumeData);
          } catch (error) {
            manager.deregisterTaskContext(task.id);
            throw error;
          }
          settled.push(executor.executed);
        };
        const registered: {
          readonly executor: ResumedExecutor;
          readonly resume: BackgroundResume;
        }[] = [];
        for (const resume of resumes) {
          registered.push({ executor: await register(resume.task), resume });
        }
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
          (taskId) => executors.get(taskId)?.terminal()
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
            for (const task of tasks) {
              wait.add(task.id);
            }
            return {
              release: () => {
                for (const task of tasks) {
                  wait.remove(task.id);
                }
              },
              resume: async (more) => {
                for (const { task, resumeData } of more) {
                  try {
                    await resumeRegistered(task, await register(task), resumeData);
                  } catch (error) {
                    wait.remove(task.id);
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
          for (const { executor, resume } of registered) {
            await resumeRegistered(resume.task, executor, resume.resumeData);
          }
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
          await Promise.all(settled);
          await manager.shutdown();
          // The user's row still reflects the returned work, even though no
          // parent inference runs on this leg.
          controller.enqueue(makeBackgroundLedgerChunk(await ledger.read(), ledger.ledgerId));
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
   * host join for its original dispatch address — or once the task reached a
   * terminal before Mastra ever started it (cancelled before it ran), which
   * nothing else would settle.
   */
  readonly executed: Promise<void>;
  /** The leg recorded the task's terminal. */
  readonly terminal: () => void;
}

/**
 * Register one task's in-process executor and result delivery with the
 * manager. Resolves once registered — never waiting for the execution, which
 * `executed` joins.
 */
async function registerResumedExecutor(params: {
  readonly controller: ReadableStreamDefaultController<unknown>;
  readonly manager: BackgroundTaskManager;
  readonly memory: MastraMemory;
  readonly onDeliveryError: (error: unknown) => void;
  readonly options: BrainstrikeAgentStreamOptions;
  readonly runtime: MastraAgentRuntime;
  readonly scope: { readonly resourceId: string; readonly threadId: string };
  readonly task: BackgroundTask;
}): Promise<ResumedExecutor> {
  const { controller, manager, memory, options, runtime, scope, task } = params;
  const executed = Promise.withResolvers<void>();
  let started = false;
  const tools = await runtime.agent.getToolsForExecution({
    methodType: 'stream',
    resourceId: scope.resourceId,
    runId: task.runId,
    threadId: scope.threadId,
    ...(options.delegation ? { delegation: options.delegation } : {}),
    outputWriter: async (chunk: unknown) => {
      controller.enqueue(chunk);
    },
  });
  const execute = tools[task.toolName]?.execute;
  if (!execute) {
    throw new Error('The original background executor is unavailable.');
  }
  manager.registerTaskContext(task.id, {
    executor: {
      execute: async (args, nativeOptions) => {
        started = true;
        let output: unknown;
        let failure: unknown;
        try {
          output = await execute(args, {
            messages: [],
            outputWriter: async (chunk: unknown) => {
              controller.enqueue(chunk);
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
  });
  return {
    executed: executed.promise,
    terminal: () => {
      if (!started) {
        executed.resolve();
      }
    },
  };
}
