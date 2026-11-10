/**
 * The Threads panel's "Needs you" strip (ADR-0034 decision 3): every thread
 * waiting on its person, across all projects, and what each waits for.
 *
 * Pure, and it adds no source of its own. The three waits are the ones the
 * rows' status glyphs already read:
 *
 * - a run held on an unanswered request (`needsYouThreadIds`), which the host
 *   folds from its committed `interaction.requested` / `interaction.responded`
 *   rows for every thread it lists, with the kinds it waits on (`waitingOn`);
 * - a run that finished, or failed, and has not been looked at since
 *   (`unseenThreadIds`, `failedUnseenThreadIds`): the host's committed finish
 *   time against the watermark the on-screen transcript advances.
 *
 * So a thread leaves the strip exactly when its glyph clears: the request is
 * answered, or the thread is shown.
 */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { AssistantThreadHostRun } from './assistant-thread-host-context';

/**
 * Why a thread is in the strip. `input` is a held run whose host names no
 * kind, so the row says only that it waits.
 */
export type ThreadNeedsYouReason = 'approval' | 'failed' | 'input' | 'plan' | 'question' | 'review';

export interface ThreadNeedsYouRow {
  readonly reason: ThreadNeedsYouReason;
  readonly thread: AssistantMemoryThread;
}

type WaitingOn = NonNullable<AssistantThreadHostRun['waitingOn']>[number];

/**
 * What a held run's row says, when it waits on more than one kind of request:
 * a question first, since no approval can answer it, then a plan, then an
 * approval. A network consent is asked on the approval card.
 */
const HELD_REASON_ORDER = [
  ['question', 'question'],
  ['plan', 'plan'],
  ['approval', 'approval'],
  ['network', 'approval'],
] as const satisfies readonly (readonly [WaitingOn, ThreadNeedsYouReason])[];

function heldReason(run: AssistantThreadHostRun | undefined): ThreadNeedsYouReason {
  const waitingOn = run?.waitingOn ?? [];
  return HELD_REASON_ORDER.find(([kind]) => waitingOn.includes(kind))?.[1] ?? 'input';
}

/** Held runs lead (they are blocked), then failures, then results to review. */
const REASON_RANK: Readonly<Record<ThreadNeedsYouReason, number>> = {
  approval: 0,
  failed: 1,
  input: 0,
  plan: 0,
  question: 0,
  review: 2,
};

export function buildThreadNeedsYouRows({
  failedUnseenThreadIds,
  hostRuns,
  lastActivityAt,
  needsYouThreadIds,
  threads,
  unseenThreadIds,
}: {
  readonly failedUnseenThreadIds: ReadonlySet<string>;
  /** The host's latest committed run per thread: where a held run's kinds come from. */
  readonly hostRuns: ReadonlyMap<string, AssistantThreadHostRun>;
  readonly lastActivityAt: (thread: AssistantMemoryThread) => number;
  readonly needsYouThreadIds: ReadonlySet<string>;
  /** Every loaded thread, whatever the list below is filtered or grouped by. */
  readonly threads: readonly AssistantMemoryThread[];
  readonly unseenThreadIds: ReadonlySet<string>;
}): readonly ThreadNeedsYouRow[] {
  const rows: ThreadNeedsYouRow[] = [];
  for (const thread of threads) {
    if (needsYouThreadIds.has(thread.id)) {
      rows.push({ reason: heldReason(hostRuns.get(thread.id)), thread });
    } else if (failedUnseenThreadIds.has(thread.id)) {
      rows.push({ reason: 'failed', thread });
    } else if (unseenThreadIds.has(thread.id)) {
      rows.push({ reason: 'review', thread });
    }
  }
  return rows.sort(
    (left, right) =>
      REASON_RANK[left.reason] - REASON_RANK[right.reason] ||
      lastActivityAt(right.thread) - lastActivityAt(left.thread) ||
      left.thread.id.localeCompare(right.thread.id)
  );
}
