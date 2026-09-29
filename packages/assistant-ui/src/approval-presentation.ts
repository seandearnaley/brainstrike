import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import {
  isToolRiskCategory,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';

/**
 * Swarm-aware approval presentation (2026-09-15, settled with Sean): ONE full
 * card per category while a decision is pending; everything already answered
 * (by the user, by a session grant, by a durable decision) and every pending
 * approval BEHIND that category's card renders as a compact row. The rules
 * are pure so the notice, the row and the composer strip agree by
 * construction.
 */

/** Policy asks bucket by risk category; a non-policy pause is its own bucket. */
export type ApprovalCategoryKey = `category:${ToolRiskCategory}` | `tool:${string}`;

export function approvalCategoryKey(
  request: Pick<AssistantToolApprovalRequest, 'riskCategory' | 'toolName'>
): ApprovalCategoryKey {
  if (isToolRiskCategory(request.riskCategory)) {
    return `category:${request.riskCategory}`;
  }
  return `tool:${request.toolName}`;
}

/** Delegation depth: 0 for the root's own pause, 1 per delegation edge. */
export function approvalDepth(request: Pick<AssistantToolApprovalRequest, 'delegation'>): number {
  return request.delegation?.path.length ?? 0;
}

export interface ApprovalRankEntry {
  readonly categoryKey: ApprovalCategoryKey;
  /** Already answered in any way — never a candidate for the category card. */
  readonly decided: boolean;
  readonly identityKey: string;
}

export interface ApprovalRanks {
  /** Pending identity keys per category, in thread order. */
  readonly pendingByCategory: ReadonlyMap<ApprovalCategoryKey, readonly string[]>;
  /** Rank among the PENDING approvals of the same category; 0 owns the card. */
  readonly rankByKey: ReadonlyMap<string, number>;
}

export function rankPendingApprovals(entries: readonly ApprovalRankEntry[]): ApprovalRanks {
  const pendingByCategory = new Map<ApprovalCategoryKey, string[]>();
  const rankByKey = new Map<string, number>();
  for (const entry of entries) {
    if (entry.decided) {
      continue;
    }
    const bucket = pendingByCategory.get(entry.categoryKey) ?? [];
    rankByKey.set(entry.identityKey, bucket.length);
    bucket.push(entry.identityKey);
    pendingByCategory.set(entry.categoryKey, bucket);
  }
  return { pendingByCategory, rankByKey };
}

export type ApprovalPresentation =
  | { readonly mode: 'card' }
  | { readonly mode: 'row'; readonly reason: 'answered' | 'behind-category-card' };

/**
 * `pendingRank` is `null` when no ranking exists for the notice (mounted
 * without the thread index, or not yet indexed): that renders the full card,
 * the pre-existing behaviour, never a row with nothing to promote it.
 */
export function resolveApprovalPresentation(input: {
  readonly answered: boolean;
  readonly pendingRank: number | null;
}): ApprovalPresentation {
  if (input.answered) {
    return { mode: 'row', reason: 'answered' };
  }
  if (input.pendingRank === null || input.pendingRank === 0) {
    return { mode: 'card' };
  }
  return { mode: 'row', reason: 'behind-category-card' };
}
