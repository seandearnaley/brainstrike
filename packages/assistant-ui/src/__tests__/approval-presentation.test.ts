import { describe, expect, it } from 'vitest';
import {
  approvalCategoryKey,
  approvalDepth,
  rankPendingApprovals,
  resolveApprovalPresentation,
} from '../approval-presentation';

const edge = (n: number) => ({
  childRuntimeRunId: `child-${n}`,
  parentRuntimeRunId: n === 1 ? 'root-run' : `child-${n - 1}`,
  parentToolCallId: `delegate-${n}`,
  personaId: 'explore',
});

describe('approvalCategoryKey', () => {
  it('buckets policy-driven asks by risk category', () => {
    expect(approvalCategoryKey({ riskCategory: 'read', toolName: 'brainstrike.grepSearch' })).toBe(
      'category:read'
    );
  });

  it('buckets a non-policy pause by its tool so it never shares a card with a category', () => {
    expect(approvalCategoryKey({ toolName: 'server.tool' })).toBe('tool:server.tool');
  });
});

describe('approvalDepth', () => {
  it('is the delegation path length; a root pause is depth 0', () => {
    expect(approvalDepth({})).toBe(0);
    expect(approvalDepth({ delegation: { path: [edge(1)], toolCallId: 'leaf' } })).toBe(1);
    expect(approvalDepth({ delegation: { path: [edge(1), edge(2)], toolCallId: 'leaf' } })).toBe(2);
  });
});

describe('rankPendingApprovals', () => {
  it('ranks pending approvals per category in thread order and skips decided ones', () => {
    const ranks = rankPendingApprovals([
      { categoryKey: 'category:read', decided: false, identityKey: 'r1' },
      { categoryKey: 'category:edit', decided: false, identityKey: 'e1' },
      { categoryKey: 'category:read', decided: true, identityKey: 'r2' },
      { categoryKey: 'category:read', decided: false, identityKey: 'r3' },
    ]);
    expect(ranks.rankByKey.get('r1')).toBe(0);
    expect(ranks.rankByKey.get('e1')).toBe(0);
    expect(ranks.rankByKey.has('r2')).toBe(false);
    expect(ranks.rankByKey.get('r3')).toBe(1);
    expect([...ranks.pendingByCategory]).toEqual([
      ['category:read', ['r1', 'r3']],
      ['category:edit', ['e1']],
    ]);
  });

  it('promotes the next pending approval once the first is decided', () => {
    const before = rankPendingApprovals([
      { categoryKey: 'category:read', decided: false, identityKey: 'r1' },
      { categoryKey: 'category:read', decided: false, identityKey: 'r2' },
    ]);
    const after = rankPendingApprovals([
      { categoryKey: 'category:read', decided: true, identityKey: 'r1' },
      { categoryKey: 'category:read', decided: false, identityKey: 'r2' },
    ]);
    expect(before.rankByKey.get('r2')).toBe(1);
    expect(after.rankByKey.get('r2')).toBe(0);
  });
});

describe('resolveApprovalPresentation', () => {
  it('collapses an answered approval into a row', () => {
    expect(resolveApprovalPresentation({ answered: true, pendingRank: 0 })).toEqual({
      mode: 'row',
      reason: 'answered',
    });
  });

  it('keeps the first pending approval of a category as the full card', () => {
    expect(resolveApprovalPresentation({ answered: false, pendingRank: 0 })).toEqual({
      mode: 'card',
    });
  });

  it('collapses a later pending approval of the same category behind the card', () => {
    expect(resolveApprovalPresentation({ answered: false, pendingRank: 2 })).toEqual({
      mode: 'row',
      reason: 'behind-category-card',
    });
  });

  it('renders a full card when no ranking is available (no provider, e.g. an isolated mount)', () => {
    expect(resolveApprovalPresentation({ answered: false, pendingRank: null })).toEqual({
      mode: 'card',
    });
  });
});
