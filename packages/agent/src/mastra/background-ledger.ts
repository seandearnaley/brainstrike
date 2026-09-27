/**
 * The ledger of a run's background invocations (settled 2026-09-15, see
 * assistant-subagents.md "WAKEUP LEDGER").
 *
 * `describeBackgroundWakeup` used to say "Background invocation X has
 * returned" once per event; over four continuations the GLM root mis-counted
 * and ended "waiting on the remaining subagents" after all four had finished
 * (thread-debug pack 2026-09-15T03-31-15Z). The wakeup is now the whole
 * ledger — returned / failed with reason / cancelled / still running — read
 * from the DURABLE task rows (`manager.listTasks`) at wakeup time, never from
 * the loop's in-memory sets alone, and it says explicitly when nothing is
 * still running. The same ledger is streamed as a `delegation.ledger` run
 * event: one live-updating row in the root thread ("3 of 4 specialists
 * returned · 1 running") that the desktop persists like every run event.
 */
import { createLogger } from '@brainstrike/logging';
import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import { projectBackgroundOutcomeForModel } from '../background-result-projection';
import type { AssistantRunEventMetadata } from '../run-events';
import type { StreamChunk } from '../types';
import { completedBackgroundOutcome } from './background-result-delivery';
import type {
  BackgroundGeneration,
  DelegatedConversationBinding,
} from './delegated-conversation-binding';
import { makeRunDetailEventChunk } from './stream-run-event-chunks';
import type { DelegationOutcomeCapture } from './subagent-delegation';

const logger = createLogger('BackgroundLedger');

export const DELEGATION_LEDGER_RUN_EVENT_KIND = 'delegation.ledger' as const;
/** The prompt excerpt the MODEL sees per entry; never persisted. */
export const MAX_LEDGER_PROMPT_CHARS = 120;

export type BackgroundLedgerState = 'cancelled' | 'failed' | 'returned' | 'running';

export interface BackgroundLedgerEntry {
  /** Compact terminal output from the same durable snapshot as the status. */
  readonly outcome?: ReturnType<typeof projectBackgroundOutcomeForModel>;
  readonly persona: string | undefined;
  readonly prompt: string | undefined;
  readonly reason: string | undefined;
  readonly state: BackgroundLedgerState;
  readonly taskId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface BackgroundLedgerCounts {
  readonly cancelled: number;
  readonly failed: number;
  readonly returned: number;
  readonly running: number;
  readonly total: number;
}

export interface BackgroundLedger {
  readonly counts: BackgroundLedgerCounts;
  readonly entries: readonly BackgroundLedgerEntry[];
  /**
   * The GENERATION this ledger belongs to (migration 140). Every leg of one
   * generation publishes under this id, so a later leg's row supersedes the
   * earlier leg's instead of standing beside it forever.
   */
  readonly ledgerId: string;
}

export interface BackgroundLedgerSource {
  /**
   * This GENERATION's ledger, from the durable rows: every task dispatched by
   * a native run the host mapped to the generation, plus the runs this leg
   * observed itself — a run whose first task has not started yet is not
   * mapped, and the leg's own observations close that window.
   */
  read(observedRunIds: ReadonlySet<string>): Promise<BackgroundLedger>;
}

const EMPTY_COUNTS: BackgroundLedgerCounts = {
  cancelled: 0,
  failed: 0,
  returned: 0,
  running: 0,
  total: 0,
};

/**
 * A parked task is a host-surfaced approval card (LIVE DECISIONS, settled
 * 2026-09-14): the model is never told about it, so to the ledger it is
 * still in progress.
 */
export function ledgerStateOf(status: BackgroundTask['status']): BackgroundLedgerState {
  switch (status) {
    case 'completed':
      return 'returned';
    case 'failed':
    case 'timed_out':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    case 'running':
    case 'suspended':
      return 'running';
    default: {
      const exhaustive: never = status;
      throw new Error(`Unknown background task status: ${String(exhaustive)}`);
    }
  }
}

function promptOf(task: BackgroundTask): string | undefined {
  const prompt = task.args['prompt'];
  return typeof prompt === 'string'
    ? Array.from(prompt).slice(0, MAX_LEDGER_PROMPT_CHARS).join('')
    : undefined;
}

function reasonOf(task: BackgroundTask): string | undefined {
  if (task.status === 'timed_out') {
    return 'timed out';
  }
  return task.status === 'failed' ? (task.error?.message ?? 'failed without a reason') : undefined;
}

function countEntries(entries: readonly BackgroundLedgerEntry[]): BackgroundLedgerCounts {
  const counts = { cancelled: 0, failed: 0, returned: 0, running: 0, total: entries.length };
  for (const entry of entries) {
    counts[entry.state] += 1;
  }
  return counts;
}

export function createBackgroundLedgerSource(params: {
  /** This leg's generation and every native run mapped to it (migration 140). */
  readonly generation: () => Promise<BackgroundGeneration>;
  readonly manager: Pick<BackgroundTaskManager, 'listTasks'>;
  readonly personaLabel: (toolName: string) => string | undefined;
  /**
   * The leg's delegation outcomes (BST-1751). Mastra answers a refusal at
   * start INSIDE the background task it already created, so the refused call
   * completes as a task row exactly like a returned child. No child ran: it is
   * no invocation of this ledger (REJECTED ADMISSION IS NO INVOCATION).
   */
  readonly rejectedDelegations: Pick<DelegationOutcomeCapture, 'rejected'> | undefined;
  /**
   * The host's invocation graph (`resolveParkedInvocation`): `undefined` when
   * an address delegated nothing. A refusal persists no invocation, so this
   * names a refused row whichever leg dispatched it — the capture above knows
   * only its own leg's, and a resume leg reads the rows of the run it resumes.
   * Undefined only without a host, where no other leg can read these rows
   * (every delegated decision needs `resolveToolAction`).
   */
  readonly resolveInvocation: DelegatedConversationBinding['resolveParkedInvocation'];
  readonly scope: { readonly resourceId: string; readonly threadId: string };
}): BackgroundLedgerSource {
  /**
   * One answer per completed row for the life of this leg. A completed row's
   * answer is settled by construction: the child's `inputProcessor` AWAITS
   * `persist` before the child streams a part, and Mastra writes a task's
   * `completed` status together with its executor result. Overlapping reads
   * share the PENDING answer — the idle loop publishes a row per lifecycle
   * event — and a rejected answer is dropped, so one transient host failure
   * never becomes this leg's permanent answer for that row.
   */
  const refusedCompletions = new Map<string, Promise<boolean>>();
  const isRefused = (task: BackgroundTask): Promise<boolean> => {
    if (params.rejectedDelegations?.rejected(task.toolCallId, task.runId)) {
      return Promise.resolve(true);
    }
    // A refusal always completes; a child still starting has not persisted its invocation yet.
    const resolveInvocation = params.resolveInvocation;
    if (task.status !== 'completed' || !resolveInvocation) {
      return Promise.resolve(false);
    }
    const known = refusedCompletions.get(task.id);
    if (known) {
      return known;
    }
    const answer = resolveInvocation({
      parentRuntimeRunId: task.runId,
      parentThreadId: params.scope.threadId,
      parentToolCallId: task.toolCallId,
    }).then((invocation) => invocation === undefined);
    // A host that cannot answer fails the read (the publisher logs
    // `background_ledger_read_failed`, the wakeup fails loudly): never an
    // answer, so never remembered.
    answer.catch(() => refusedCompletions.delete(task.id));
    refusedCompletions.set(task.id, answer);
    return answer;
  };
  return {
    async read(observedRunIds) {
      const { generationRunId, nativeRunIds } = await params.generation();
      const runIds = new Set([...nativeRunIds, ...observedRunIds]);
      if (runIds.size === 0) {
        return { counts: EMPTY_COUNTS, entries: [], ledgerId: generationRunId };
      }
      const { tasks } = await params.manager.listTasks({
        resourceId: params.scope.resourceId,
        threadId: params.scope.threadId,
      });
      const dispatched = tasks.filter((task) => runIds.has(task.runId));
      const refused = await Promise.all(dispatched.map(isRefused));
      const entries = dispatched
        .filter((_task, index) => !refused[index])
        .map(
          (task): BackgroundLedgerEntry => ({
            ...(ledgerStateOf(task.status) === 'running'
              ? {}
              : {
                  outcome: projectBackgroundOutcomeForModel(completedBackgroundOutcome(task)),
                }),
            persona: params.personaLabel(task.toolName),
            prompt: promptOf(task),
            reason: reasonOf(task),
            state: ledgerStateOf(task.status),
            taskId: task.id,
            toolCallId: task.toolCallId,
            toolName: task.toolName,
          })
        );
      return { counts: countEntries(entries), entries, ledgerId: generationRunId };
    },
  };
}

/**
 * The generation port a background leg reads its ledger identity and scope
 * from. Background work without the host port is an unrunnable configuration,
 * never a degraded one: a leg that cannot name its generation would publish
 * rows under an identity no other leg of the turn shares, which is the bug
 * this port exists to end (BST-1749, PR #3198 review item 5).
 */
export function requireBackgroundGeneration(
  binding: DelegatedConversationBinding | undefined
): () => Promise<BackgroundGeneration> {
  const read = binding?.readBackgroundGeneration;
  if (!read) {
    throw new Error(
      'Background work requires the host generation port (readBackgroundGeneration, migration 140).'
    );
  }
  return read;
}

/** The port mapping each native ROOT run a leg starts to that host leg. */
export function requireNativeRootRunRecorder(
  binding: DelegatedConversationBinding | undefined
): (nativeRunId: string) => Promise<void> {
  const record = binding?.recordNativeRootRun;
  if (!record) {
    throw new Error(
      'Background work requires the host native-run port (recordNativeRootRun, migration 140).'
    );
  }
  return record;
}

export function personaLabelFor(runtime: {
  readonly delegationToolPersonas: ReadonlyMap<string, string>;
  readonly personasById: ReadonlyMap<string, { readonly label: string }>;
}): (toolName: string) => string | undefined {
  return (toolName) => {
    const personaId = runtime.delegationToolPersonas.get(toolName);
    return personaId === undefined ? undefined : runtime.personasById.get(personaId)?.label;
  };
}

function describeEntry(entry: BackgroundLedgerEntry): string {
  const who = entry.persona ? `${entry.toolName}, ${entry.persona}` : entry.toolName;
  const head = `- ${entry.toolCallId} (${who})`;
  const prompt = entry.prompt ? ` Prompt: "${entry.prompt}".` : '';
  switch (entry.state) {
    case 'returned':
      return `${head}: returned.${prompt} Use its saved outcome; do not execute it again.`;
    case 'failed':
      return `${head}: failed — ${entry.reason ?? 'no reason recorded'}.${prompt} Its failure is in the conversation. Do not retry it unless the user asks.`;
    case 'cancelled':
      return `${head}: cancelled by the user; it has no result.${prompt} Do not call it again unless the user asks.`;
    case 'running':
      return `${head}: still running.${prompt} Its outcome will be delivered when it finishes.`;
    default: {
      const exhaustive: never = entry.state;
      throw new Error(`Unknown ledger state: ${String(exhaustive)}`);
    }
  }
}

/** The parent wakeup: the whole ledger, and an explicit "nothing is still running" when true. */
export function describeBackgroundWakeup(ledger: BackgroundLedger): string {
  const { counts } = ledger;
  const lines = [
    `Background invocations of this turn — ${counts.total} total: ${counts.returned} returned, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.running} still running.`,
    ...ledger.entries.map(describeEntry),
  ];
  if (counts.running === 0) {
    lines.push(
      `All ${counts.total} background invocations have finished. Nothing is still running. Continue with the task using the saved outcomes.`
    );
  } else {
    lines.push('Do not re-dispatch a running invocation; its outcome will be delivered.');
  }
  return lines.join('\n');
}

export function ledgerLabel(ledger: BackgroundLedger): string {
  const { counts } = ledger;
  const noun = counts.total === 1 ? 'specialist' : 'specialists';
  const segments = [`${counts.returned} of ${counts.total} ${noun} returned`];
  if (counts.running > 0) {
    segments.push(`${counts.running} running`);
  }
  if (counts.failed > 0) {
    segments.push(`${counts.failed} failed`);
  }
  if (counts.cancelled > 0) {
    segments.push(`${counts.cancelled} cancelled`);
  }
  return segments.join(' · ');
}

/**
 * The user's row. Content-free: persona and state only — the prompt and the
 * failure reason are workspace text and stay in the model-facing wakeup.
 * Status describes the fan-out, not the parent turn: running while any task
 * runs, then failed/cancelled if any task ended that way, else completed.
 */
export function makeBackgroundLedgerChunk(ledger: BackgroundLedger): StreamChunk {
  const metadata: AssistantRunEventMetadata = { ledgerId: ledger.ledgerId, ...ledger.counts };
  return makeRunDetailEventChunk(
    DELEGATION_LEDGER_RUN_EVENT_KIND,
    ledger.counts.running > 0
      ? 'running'
      : ledger.counts.failed > 0
        ? 'failed'
        : ledger.counts.cancelled > 0
          ? 'cancelled'
          : 'completed',
    ledgerLabel(ledger),
    ledger.entries.map((entry) => `${entry.persona ?? entry.toolName} ${entry.state}`).join(' · '),
    metadata
  );
}

export interface LedgerPublisher {
  /** Resolves once every in-flight read has settled (published or logged). */
  idle(): Promise<void>;
  /** Rows whose durable read has not settled yet. */
  readonly inFlight: number;
  publish(observedRunIds: ReadonlySet<string>): void;
}

/**
 * Publishes a ledger row per call and lets the owning phase JOIN in-flight
 * reads before it closes its stream: without the join a leg settling right
 * after the last terminal would close before the final "4 of 4" row was
 * enqueued, and reload would show the persisted "3 of 4 · 1 running".
 */
export function createLedgerPublisher(params: {
  readonly enqueue: (chunk: StreamChunk) => boolean;
  readonly onSettled: () => void;
  readonly source: BackgroundLedgerSource;
}): LedgerPublisher {
  let inFlight = 0;
  let waiters: (() => void)[] = [];
  const settleOne = () => {
    inFlight -= 1;
    if (inFlight === 0) {
      const resolved = waiters;
      waiters = [];
      for (const resolve of resolved) {
        resolve();
      }
    }
    params.onSettled();
  };
  return {
    idle() {
      if (inFlight === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    get inFlight() {
      return inFlight;
    },
    publish(observedRunIds) {
      inFlight += 1;
      void params.source
        .read(observedRunIds)
        .then((ledger) => {
          params.enqueue(makeBackgroundLedgerChunk(ledger));
        })
        .catch((error: unknown) => {
          logger.error('Background ledger read failed; no status row published for this change', {
            code: 'background_ledger_read_failed',
            error: error instanceof Error ? error.message : String(error),
            observedRunIds: [...observedRunIds],
          });
        })
        .finally(settleOne);
    },
  };
}
