import { createContext, use } from 'react';
import type { ApprovalCategoryKey, ApprovalRanks } from './approval-presentation';

/**
 * The thread's card-vs-row ranks, provided by `ApprovalRanksProvider`
 * (`approval-presentation-context.tsx`). Component-free so the provider file
 * keeps its Fast Refresh boundary (react-refresh `only-export-components`).
 */
export const ApprovalRanksContext = createContext<ApprovalRanks | null>(null);

const EMPTY_PENDING: ReadonlyMap<ApprovalCategoryKey, readonly string[]> = new Map();

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
