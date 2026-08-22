/**
 * "Unseen" for the Threads panel (BST-1404): threads whose most recent run
 * reached a TERMINAL state after the user last looked at them.
 *
 * The watermark (`lastViewedAtByThreadId`, epoch ms) and the `unseenBaselineAt`
 * floor beneath it live in `assistant-thread-store.ts` and are monotonic there;
 * this module owns only the two halves the panel needs — the pure derivation,
 * and the effect that advances the watermark for the ACTIVE thread.
 */
import type { AssistantMemoryThread, AssistantThreadRunStatus } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { useEffect, useMemo } from 'react';

/** Run states that produce something for the user to come back to. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AssistantThreadRunStatus> = new Set([
  'cancelled',
  'completed',
  'failed',
]);

export interface UnseenThreadIds {
  /** `unseen` members whose latest run FAILED — a strict subset of `unseen`. */
  readonly failedUnseen: ReadonlySet<string>;
  readonly unseen: ReadonlySet<string>;
}

export interface UnseenThreadIdsArgs {
  /** The thread on screen. It is being watched, so it is never "unseen". */
  readonly activeThreadId: string | null;
  readonly lastViewedAtByThreadId: Readonly<Record<string, number>>;
  readonly threads: readonly AssistantMemoryThread[];
  /**
   * Epoch ms below which nothing is unseen — `unseenBaselineAt` from the thread
   * store, stamped once at first run and again on the v3 -> v4 migrate.
   *
   * A FLOOR under the per-thread watermark, never a replacement for it: without
   * it an empty watermark record reads as "the user has never seen anything",
   * and every thread whose latest run ever completed lights up on first launch.
   */
  readonly unseenBaselineAt: number;
}

/**
 * Pure projection. A terminal run with NO `completedAt` is excluded: without a
 * completion time there is nothing to compare against the watermark, and
 * substituting `startedAt` or `Date.now()` would invent the very fact the badge
 * claims to report.
 */
export function deriveUnseenThreadIds({
  activeThreadId,
  lastViewedAtByThreadId,
  threads,
  unseenBaselineAt,
}: UnseenThreadIdsArgs): UnseenThreadIds {
  const unseen = new Set<string>();
  const failedUnseen = new Set<string>();
  for (const thread of threads) {
    const latestRun = thread.latestRun;
    if (!(latestRun && TERMINAL_RUN_STATUSES.has(latestRun.status))) {
      continue;
    }
    const completedAt = latestRun.completedAt;
    if (completedAt === null || thread.id === activeThreadId) {
      continue;
    }
    const seenUpTo = Math.max(lastViewedAtByThreadId[thread.id] ?? 0, unseenBaselineAt);
    if (completedAt.getTime() <= seenUpTo) {
      continue;
    }
    unseen.add(thread.id);
    if (latestRun.status === 'failed') {
      failedUnseen.add(thread.id);
    }
  }
  return { failedUnseen, unseen };
}

/** {@link deriveUnseenThreadIds}, memoized on its inputs. */
export function useUnseenThreadIds(args: UnseenThreadIdsArgs): UnseenThreadIds {
  const { activeThreadId, lastViewedAtByThreadId, threads, unseenBaselineAt } = args;
  return useMemo(
    () =>
      deriveUnseenThreadIds({
        activeThreadId,
        lastViewedAtByThreadId,
        threads,
        unseenBaselineAt,
      }),
    [activeThreadId, lastViewedAtByThreadId, threads, unseenBaselineAt]
  );
}

/**
 * Advances the viewed watermark for the ACTIVE thread.
 *
 * Two marks, both required:
 * - on the way IN and OUT of a thread (the cleanup marks the outgoing one), so
 *   switching away from a thread you just read does not leave it unseen;
 * - again whenever the active thread's latest run reaches a NEW completion time
 *   while it is still active. Without this, a run that finishes in the
 *   FOREGROUND would out-run the mount-time watermark and the thread would read
 *   as unseen the moment the user switched away — a badge for something they
 *   watched happen.
 *
 * The stamp is `max(now, completedAt)`: the completion timestamp comes from the
 * database clock, so a renderer clock that trails it must not leave a watermark
 * below the very completion it just observed.
 */
export function useMarkActiveThreadViewed({
  activeThreadId,
  threads,
}: {
  readonly activeThreadId: string | null;
  readonly threads: readonly AssistantMemoryThread[];
}): void {
  const markThreadViewed = useAssistantThreadStore((state) => state.markThreadViewed);
  const activeCompletedAtMs = useMemo(() => {
    if (activeThreadId === null) {
      return null;
    }
    const completedAt = threads.find((thread) => thread.id === activeThreadId)?.latestRun
      ?.completedAt;
    return completedAt ? completedAt.getTime() : null;
  }, [activeThreadId, threads]);

  useEffect(() => {
    if (activeThreadId === null) {
      return;
    }
    const mark = (): void => {
      markThreadViewed(activeThreadId, Math.max(Date.now(), activeCompletedAtMs ?? 0));
    };
    mark();
    return mark;
  }, [activeCompletedAtMs, activeThreadId, markThreadViewed]);
}
