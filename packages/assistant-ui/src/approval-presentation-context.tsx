import { createContext, type ReactNode, use, useMemo } from 'react';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { useAnsweredApprovals } from './answered-approvals-index';
import {
  type ApprovalCategoryKey,
  type ApprovalRanks,
  approvalCategoryKey,
  rankPendingApprovals,
} from './approval-presentation';
import { followUpQueueKey, useFollowUpQueueStore } from './follow-up-queue-store';

/**
 * Card-vs-row ranking for every approval notice in the thread, computed ONCE
 * per index change (never per card): the first PENDING approval of each
 * category owns the full card; the rest are rows. "Decided" folds every way
 * a notice can already be answered — the host's answer, a durable decision
 * state on the part, the user's own appended decision, and a decision still
 * waiting in the follow-up queue.
 */
const ApprovalRanksContext = createContext<ApprovalRanks | null>(null);

const EMPTY_PENDING: ReadonlyMap<ApprovalCategoryKey, readonly string[]> = new Map();

export function ApprovalRanksProvider({ children }: { children: ReactNode }) {
  const index = useAnsweredApprovals();
  const threadKey = use(ActiveThreadKeyContext);
  const queued = useFollowUpQueueStore(
    (state) => state.queuedByThread[followUpQueueKey(threadKey)]
  );
  const ranks = useMemo(() => {
    const queuedKeys = new Set(
      (queued ?? []).flatMap((item) => (item.identityKey ? [item.identityKey] : []))
    );
    return rankPendingApprovals(
      [...index.requests].map(([identityKey, entry]) => ({
        categoryKey: approvalCategoryKey(entry.request),
        decided:
          entry.decided ||
          index.answers.has(identityKey) ||
          index.userDecisions.has(identityKey) ||
          queuedKeys.has(identityKey),
        identityKey,
      }))
    );
  }, [index, queued]);
  return <ApprovalRanksContext.Provider value={ranks}>{children}</ApprovalRanksContext.Provider>;
}

/**
 * Rank among the PENDING approvals of the same category (0 owns the card),
 * or `null` when there is no provider, the approval is not indexed, or it
 * is already decided.
 */
export function useApprovalRank(identityKey: string | null): number | null {
  const ranks = use(ApprovalRanksContext);
  if (ranks === null || identityKey === null) {
    return null;
  }
  return ranks.rankByKey.get(identityKey) ?? null;
}

/** Pending identity keys per category, in thread order; empty without a provider. */
export function usePendingApprovalsByCategory(): ReadonlyMap<
  ApprovalCategoryKey,
  readonly string[]
> {
  return use(ApprovalRanksContext)?.pendingByCategory ?? EMPTY_PENDING;
}
