/**
 * Each BACKGROUND child's own stream under its own watchdog
 * (docs/agents/assistant-runtime.md, "Stream inactivity watchdog").
 *
 * A background child streams inside its native task, and its parts reach the
 * host through the task's `background-task-output` events (or, on a resume
 * leg, through the executor the host runs itself). One stream-level timer on
 * the parent's combined stream could not tell one wedged child from its
 * producing siblings, and its all-quiet stall aborted the whole leg. Here every
 * running child is judged ALONE, by the same phase-aware `withInactivityTimeout`
 * and the same four windows the parent uses: a stall ends that child's
 * execution with {@link BackgroundChildStalledError}, its task fails as its own
 * task, and the parent is woken with the failure like any other.
 *
 * A child is watched from its execution's start (`running`, `resumed`, or a
 * host-run executor) until its own stream ends (`finish`, a provider error, an
 * abort, a tripwire) or it parks on a human (an approval or a suspension), or
 * its task reaches a terminal. What follows its stream's end — persisting its
 * outcome — is host work, not the child's silence; the parent bounds the wait
 * for that terminal (`StreamInactivityOptions.heldWork`).
 *
 * One instance per runtime, following the manager's lifecycle stream for the
 * root agent's scope from construction, so no event of a task this runtime
 * runs can precede it.
 */

import { createLogger } from '@brainstrike/logging';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { ChunkType } from '@mastra/core/stream';
import type { AssistantResilienceConfig } from '../config/resilience-config';
import type { AssistantRunEventMetadata } from '../run-events';
import {
  type HeldWorkWatch,
  type StreamInactivityWindows,
  StreamStalledError,
  type StreamStallPhase,
  withInactivityTimeout,
} from '../stream/with-inactivity-timeout';
import type {
  DelegatedCancellationTarget,
  DelegatedConversationBinding,
} from './delegated-conversation-binding';
import { createMastraAgentError } from './mastra-agent-error';
import {
  describeMastraStreamPartType,
  resolveMastraProducerOptions,
  unwrapDelegatedChildPart,
} from './mastra-watchdog-options';
import { readMastraStreamPartString, readMastraStreamPartValue } from './tool-event-mapper';

const logger = createLogger('BackgroundChildWatchdog');

const PHASE_WORDING = {
  'awaiting-output': { during: 'while waiting for its first output', window: 'first-output' },
  reasoning: { during: 'while reasoning', window: 'reasoning-gap' },
  streaming: { during: 'while streaming its answer', window: 'inter-output' },
  'tool-executing': { during: 'while a tool call was running', window: 'tool-executing' },
} as const satisfies Record<StreamStallPhase, { readonly during: string; readonly window: string }>;

/**
 * Why a background child's execution was ended: its own stream outlived the
 * window of the phase it was in. The message is what the task records as its
 * failure, so it reaches the parent's wakeup ledger and the child's view.
 */
export class BackgroundChildStalledError extends Error {
  readonly code = 'background_child_stalled';
  readonly inactivityMs: number;
  readonly lastPartType: string | undefined;
  readonly partsSeen: number;
  readonly phase: StreamStallPhase;

  constructor(stall: StreamStalledError) {
    const wording = PHASE_WORDING[stall.phase];
    super(
      `Subagent stalled: no output for ${stall.inactivityMs}ms ${wording.during} (its ${wording.window} window), so the host ended it.`
    );
    this.name = 'BackgroundChildStalledError';
    this.inactivityMs = stall.inactivityMs;
    this.lastPartType = stall.lastPartType;
    this.partsSeen = stall.partsSeen;
    this.phase = stall.phase;
  }
}

/**
 * The child's failed-terminal detail for an execution that ended on `reason`,
 * with the stall's breadcrumb when its own watchdog ended it.
 */
export function describeChildExecutionEnd(reason: unknown): {
  readonly detail: string;
  readonly metadata?: AssistantRunEventMetadata;
} {
  if (!(reason instanceof BackgroundChildStalledError)) {
    return { detail: String(reason) };
  }
  return {
    detail: reason.message,
    metadata: {
      code: reason.code,
      inactivityMs: reason.inactivityMs,
      partsSeen: reason.partsSeen,
      phase: reason.phase,
      ...(reason.lastPartType ? { lastPartType: reason.lastPartType } : {}),
    },
  };
}

/** One background task's identity: its task id and the delegation that dispatched it. */
export interface BackgroundChildTask {
  /** The parent run that dispatched it. */
  readonly runId: string;
  readonly taskId: string;
  /** Its delegation call on that run. */
  readonly toolCallId: string;
}

/** An execution the host runs itself: it feeds its child's parts and says when it ends. */
export interface HostExecutionWatch {
  end(): void;
  observe(output: unknown): void;
}

export interface BackgroundChildWatchdogs extends HeldWorkWatch {
  dispose(): void;
  /** Watch an execution the host runs itself (a resume leg's executor) from now until `end`. */
  hostExecution(task: BackgroundChildTask): HostExecutionWatch;
}

export interface BackgroundChildWatchdogsParams {
  /**
   * End the stalled child's live execution with `stall` (the delegation
   * binding's `endStalledExecution`); `false` when no execution of it runs here.
   */
  readonly endExecution: (
    target: DelegatedCancellationTarget,
    stall: BackgroundChildStalledError
  ) => boolean;
  /** The runtime's guarded tool names: a child's guarded call rides `tool-executing`. */
  readonly guardedToolNames: ReadonlySet<string>;
  readonly manager: Pick<BackgroundTaskManager, 'stream'>;
  /** The root agent's scope: only its tasks are background children. */
  readonly scope: {
    readonly agentId: string;
    readonly resourceId: string;
    readonly threadId: string;
  };
  readonly windows: StreamInactivityWindows;
}

/**
 * What each native lifecycle event does to its task's watch. Typed against
 * Mastra's own chunk union, so a rename fails to compile rather than leaving
 * a child unwatched.
 */
const MASTRA_TASK_WATCH_EFFECTS = {
  'background-task-cancelled': 'ends',
  'background-task-completed': 'ends',
  'background-task-failed': 'ends',
  'background-task-output': 'output',
  'background-task-resumed': 'watches-again',
  'background-task-running': 'watches',
  'background-task-suspended': 'ends',
} as const satisfies Partial<
  Record<ChunkType['type'], 'ends' | 'output' | 'watches' | 'watches-again'>
>;

/**
 * The child's own parts after which its stream has nothing left to judge: its
 * end, or a pause on a human. A paused child's stream closes with no `finish`
 * (measured through the real background manager).
 */
const MASTRA_CHILD_STREAM_ENDS: ReadonlySet<string> = new Set([
  'abort',
  'error',
  'finish',
  'tool-call-approval',
  'tool-call-suspended',
  'tripwire',
] satisfies ChunkType['type'][]);

interface ChildStreamWatch {
  push(part: unknown): void;
  stop(): void;
}

/** One child's own stream, judged by the parent's own watchdog and windows. */
function watchChildStream(
  options: ReturnType<typeof resolveMastraProducerOptions>,
  windows: StreamInactivityWindows,
  onStall: (stall: StreamStalledError) => void
): ChildStreamWatch {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  const signal = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  async function* parts(): AsyncGenerator<unknown> {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift();
      }
      if (stopped) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  void (async () => {
    try {
      for await (const _part of withInactivityTimeout(parts(), windows, options)) {
        // Each part re-arms this child's own timer; the verdict is the watchdog's.
      }
    } catch (error) {
      // The source never throws: only the watchdog's own verdict reaches here.
      if (!(error instanceof StreamStalledError)) {
        throw error;
      }
      if (!stopped) {
        onStall(error);
      }
    }
  })();
  return {
    push(part) {
      if (stopped) {
        return;
      }
      queue.push(part);
      signal();
    },
    stop() {
      stopped = true;
      signal();
    },
  };
}

/** The identity fields a native lifecycle event of `effect` must carry. */
const REQUIRED_EVENT_FIELDS = {
  ends: ['taskId'],
  output: ['taskId'],
  watches: ['taskId', 'runId', 'toolCallId'],
  'watches-again': ['taskId', 'runId', 'toolCallId'],
} as const satisfies Record<
  (typeof MASTRA_TASK_WATCH_EFFECTS)[keyof typeof MASTRA_TASK_WATCH_EFFECTS],
  readonly ('runId' | 'taskId' | 'toolCallId')[]
>;

/**
 * The watchdogs of every background child of one runtime. `watching(held)`
 * and `subscribe()` tell the parent's watchdog whether the work its stream
 * holds is being judged.
 */
export function createBackgroundChildWatchdogs(
  params: BackgroundChildWatchdogsParams
): BackgroundChildWatchdogs {
  const options = resolveMastraProducerOptions(params.guardedToolNames);
  const watches = new Map<string, ChildStreamWatch>();
  /**
   * Tasks whose execution this instance saw end. A late or replayed
   * `running` never watches one again (a new manager subscriber is re-told
   * every task still listed as running); only a resume starts a new execution.
   */
  const ended = new Set<string>();
  /**
   * Tasks whose executions the host runs itself (a resume leg's executor).
   * Their parts reach the host through that executor, never as task output,
   * so only `hostExecution` watches them: the manager's copy of their
   * lifecycle — a `resumed` that lands after the execution already ended —
   * would start a watch nothing feeds.
   */
  const hostRun = new Set<string>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const announce = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const stopWatching = (taskId: string) => {
    ended.add(taskId);
    const watch = watches.get(taskId);
    if (!watch) {
      return;
    }
    watches.delete(taskId);
    watch.stop();
    announce();
  };
  const stalled = (
    task: BackgroundChildTask,
    watch: ChildStreamWatch,
    error: StreamStalledError
  ) => {
    if (watches.get(task.taskId) !== watch) {
      return;
    }
    stopWatching(task.taskId);
    const stall = new BackgroundChildStalledError(error);
    const context = {
      inactivityMs: stall.inactivityMs,
      partsSeen: stall.partsSeen,
      phase: stall.phase,
      runId: task.runId,
      taskId: task.taskId,
      toolCallId: task.toolCallId,
      ...(stall.lastPartType ? { lastPartType: stall.lastPartType } : {}),
    };
    if (
      params.endExecution(
        { parentRuntimeRunId: task.runId, parentToolCallId: task.toolCallId },
        stall
      )
    ) {
      logger.error('Background child stalled; its execution ends as a failed task', {
        code: stall.code,
        ...context,
      });
      return;
    }
    // Nothing runs here to end: the parent's bound on held work nothing
    // watches is what waits for this task's terminal now.
    logger.error('Background child stalled, but no live execution of it runs here to end', {
      code: 'background_child_stall_undeliverable',
      ...context,
    });
  };
  const watch = (task: BackgroundChildTask, startsExecution: boolean) => {
    if (disposed || watches.has(task.taskId) || (ended.has(task.taskId) && !startsExecution)) {
      return;
    }
    ended.delete(task.taskId);
    const childWatch: ChildStreamWatch = watchChildStream(options, params.windows, (error) =>
      stalled(task, childWatch, error)
    );
    watches.set(task.taskId, childWatch);
    announce();
  };
  const observe = (taskId: string, output: unknown) => {
    const childWatch = watches.get(taskId);
    if (!childWatch) {
      return;
    }
    // The task's own delegation envelope is transport; the child's part is
    // inside — possibly none, which is still not the envelope itself.
    const envelope = unwrapDelegatedChildPart(output);
    const part = envelope ? envelope.child : output;
    childWatch.push(part);
    const type = describeMastraStreamPartType(part);
    if (type !== undefined && MASTRA_CHILD_STREAM_ENDS.has(type)) {
      stopWatching(taskId);
    }
  };
  const follow = (event: unknown) => {
    const type = describeMastraStreamPartType(event);
    if (type === undefined || !Object.hasOwn(MASTRA_TASK_WATCH_EFFECTS, type)) {
      return;
    }
    const effect = MASTRA_TASK_WATCH_EFFECTS[type as keyof typeof MASTRA_TASK_WATCH_EFFECTS];
    const identity = {
      runId: readMastraStreamPartString(event, 'runId'),
      taskId: readMastraStreamPartString(event, 'taskId'),
      toolCallId: readMastraStreamPartString(event, 'toolCallId'),
    };
    const missing = REQUIRED_EVENT_FIELDS[effect].filter((field) => identity[field] === undefined);
    if (missing.length > 0) {
      // One event the watchdogs cannot attribute; every other child stays judged.
      logger.error('Background child watchdogs skipped a lifecycle event missing its identity', {
        code: 'background_child_watchdog_event_malformed',
        eventType: type,
        missing,
      });
      return;
    }
    const { runId, taskId, toolCallId } = identity;
    if (taskId === undefined) {
      return;
    }
    if (effect === 'ends') {
      stopWatching(taskId);
      return;
    }
    if (hostRun.has(taskId)) {
      return;
    }
    if (effect === 'output') {
      observe(
        taskId,
        readMastraStreamPartValue((event as { payload?: unknown }).payload, 'payload')
      );
      return;
    }
    if (runId !== undefined && toolCallId !== undefined) {
      watch({ runId, taskId, toolCallId }, effect === 'watches-again');
    }
  };
  const following = new AbortController();
  const dispose = () => {
    disposed = true;
    following.abort();
    // Announce each stop first, so a waiting parent re-judges its held work.
    for (const taskId of [...watches.keys()]) {
      stopWatching(taskId);
    }
    listeners.clear();
  };

  const reader = params.manager
    .stream({ abortSignal: following.signal, ...params.scope })
    .getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        follow(value);
      }
      if (!disposed) {
        // No child's lifecycle can arrive any more, so no child can be judged:
        // stop every watch rather than let it stall blind, and let the parent
        // bound its held work at the first-output window.
        logger.error('Background child watchdogs lost their lifecycle feed; watching no child', {
          code: 'background_child_watchdog_feed_ended',
          watching: [...watches.keys()],
        });
        dispose();
      }
    } catch (error) {
      // A manager may error the stream on our own abort: that is disposal.
      if (!disposed) {
        logger.error('Background child watchdogs lost their lifecycle feed; watching no child', {
          code: 'background_child_watchdog_feed_failed',
          error: error instanceof Error ? error.message : String(error),
          watching: [...watches.keys()],
        });
        dispose();
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    dispose,
    hostExecution(task) {
      hostRun.add(task.taskId);
      watch(task, true);
      return {
        end: () => stopWatching(task.taskId),
        observe: (output) => observe(task.taskId, output),
      };
    },
    subscribe(listener) {
      if (disposed) {
        return () => {
          // Nothing will change any more.
        };
      }
      const own = () => listener();
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    watching: (held) => [...held].some((taskId) => watches.has(taskId)),
  };
}

/**
 * Each background child's own watchdog, for a runtime that runs background
 * children. It can end a stalled child only through the host binding's
 * execution control, so a background runtime without it fails construction:
 * a wedged child would otherwise hold the leg open with nothing to end it.
 */
export function watchBackgroundChildren(
  manager: BackgroundTaskManager | undefined,
  options: {
    readonly backgroundTaskScope?:
      | { readonly resourceId: string; readonly threadId: string }
      | undefined;
    readonly conversationBinding?:
      | Pick<DelegatedConversationBinding, 'endStalledExecution'>
      | undefined;
  },
  agentId: string,
  toolNameMap: ReadonlyMap<string, string>,
  resilienceConfig: AssistantResilienceConfig
): BackgroundChildWatchdogs | undefined {
  if (!manager) {
    return;
  }
  const endExecution = options.conversationBinding?.endStalledExecution;
  const scope = options.backgroundTaskScope;
  if (!(endExecution && scope)) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Background children require the host binding to end a stalled child execution.',
    });
  }
  return createBackgroundChildWatchdogs({
    endExecution,
    guardedToolNames: new Set(toolNameMap.keys()),
    manager,
    scope: { agentId, ...scope },
    windows: {
      firstOutputMs: resilienceConfig.streamFirstOutputMs,
      interOutputMs: resilienceConfig.streamInactivityMs,
      reasoningGapMs: resilienceConfig.streamReasoningGapMs,
      toolExecutingMs: resilienceConfig.toolExecutingMs,
    },
  });
}
