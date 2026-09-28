/**
 * "Unseen" for the Threads panel (BST-1404): threads whose most recent run
 * reached a TERMINAL state after the user last looked at them.
 *
 * The watermark (`lastViewedAtByThreadId`, epoch ms) and the `unseenBaselineAt`
 * floor beneath it live in `assistant-thread-store.ts` and are monotonic there;
 * this module owns only the two halves the panel needs — the pure derivation,
 * and the effect that advances the watermark for the thread ON SCREEN.
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
  readonly lastViewedAtByThreadId: Readonly<Record<string, number>>;
  /**
   * The thread whose transcript is on screen right now (see
   * `useOnScreenThreadId`). It is being watched, so it is never "unseen".
   * `null` when none is — Settings showing, a background window, no transcript
   * surface mounted — and then every thread is a candidate, the last-open one
   * included.
   */
  readonly onScreenThreadId: string | null;
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
  onScreenThreadId,
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
    if (completedAt === null || thread.id === onScreenThreadId) {
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
  const { onScreenThreadId, lastViewedAtByThreadId, threads, unseenBaselineAt } = args;
  return useMemo(
    () =>
      deriveUnseenThreadIds({
        lastViewedAtByThreadId,
        onScreenThreadId,
        threads,
        unseenBaselineAt,
      }),
    [onScreenThreadId, lastViewedAtByThreadId, threads, unseenBaselineAt]
  );
}

/**
 * Advances the viewed watermark for the thread that is ON SCREEN.
 *
 * "Seen" means the thread's transcript is showing while the window is active
 * (BST-1845) — whether the thread is merely the ACTIVE one says nothing about
 * that, since the surface stays mounted under Settings and in a background
 * window. `onScreenThreadId` is that fact, published once by the transcript
 * surface; this hook only reacts to it.
 *
 * It stamps on TRANSITIONS, never continuously: when a thread comes on screen
 * (including switching from another), and when the on-screen thread's latest
 * run reaches a NEW completion time. A continuous stamp would defeat any future
 * "mark unread". There is deliberately no stamp on the way OUT: it marked a run
 * seen that finished off screen and was never shown.
 *
 * The stamp is that run's own `completedAt` — the value the badge compares
 * against — not `Date.now()`, so host/renderer clock skew cannot leave a
 * watermark below the completion it just observed. A thread with no terminal
 * completion (loading, running, no run) has nothing to stamp.
 */
export function useMarkOnScreenThreadViewed({
  onScreenThreadId,
  threads,
}: {
  readonly onScreenThreadId: string | null;
  readonly threads: readonly AssistantMemoryThread[];
}): void {
  const markThreadViewed = useAssistantThreadStore((state) => state.markThreadViewed);
  const completedAtMs = useMemo(() => {
    if (onScreenThreadId === null) {
      return null;
    }
    const latestRun = threads.find((thread) => thread.id === onScreenThreadId)?.latestRun;
    if (!(latestRun && TERMINAL_RUN_STATUSES.has(latestRun.status) && latestRun.completedAt)) {
      return null;
    }
    return latestRun.completedAt.getTime();
  }, [onScreenThreadId, threads]);

  useEffect(() => {
    if (onScreenThreadId === null || completedAtMs === null) {
      return;
    }
    markThreadViewed(onScreenThreadId, completedAtMs);
  }, [completedAtMs, markThreadViewed, onScreenThreadId]);
}
