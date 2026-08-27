import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { type ForgePrCacheEntry, forgePrCacheKey } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import type { ThreadBranchLookup } from '../thread-branch-resolution';
import { lookupThreadForgePr } from '../thread-forge-pr-resolution';

const THREAD: AssistantMemoryThread = {
  createdAt: new Date('2026-08-24T00:00:00Z'),
  id: 'thread-1',
  metadata: { operatingRootId: 'root-1', operatingRootPath: '/repos/widgets' },
  resourceId: 'workspace-memory',
  title: 'Ship the widget',
  updatedAt: new Date('2026-08-24T01:00:00Z'),
};

const PR: ForgePrCacheEntry = {
  branch: 'main',
  checksRollup: 'passing',
  isDraft: false,
  number: 2574,
  repoCommonDir: '/repos/widgets/.git',
  state: 'open',
  url: 'https://github.test/acme/widgets/pull/2574',
};

function branchLookup(
  gitCommonDir = '/repos/widgets/.git',
  branch: string | null = 'main',
  detached = false
): ThreadBranchLookup {
  return {
    byRootId: new Map([['root-1', { branch, detached, gitCommonDir }]]),
    byRootIdAndPath: new Map(),
    byRootPath: new Map(),
  };
}

describe('lookupThreadForgePr', () => {
  it('joins the resolved thread branch to its cached pull request', () => {
    const cache = new Map([[forgePrCacheKey(PR.repoCommonDir, PR.branch), PR]]);

    expect(lookupThreadForgePr(THREAD, branchLookup(), cache)).toBe(PR);
  });

  it('returns null when the thread has no resolvable branch', () => {
    const emptyLookup: ThreadBranchLookup = {
      byRootId: new Map(),
      byRootIdAndPath: new Map(),
      byRootPath: new Map(),
    };

    expect(lookupThreadForgePr(THREAD, emptyLookup, new Map())).toBeNull();
  });

  it('returns null for a detached HEAD', () => {
    const cache = new Map([[forgePrCacheKey(PR.repoCommonDir, PR.branch), PR]]);

    expect(
      lookupThreadForgePr(THREAD, branchLookup(PR.repoCommonDir, null, true), cache)
    ).toBeNull();
  });

  it("never borrows another repository's PR for the same branch name", () => {
    const otherRepoPr: ForgePrCacheEntry = {
      ...PR,
      repoCommonDir: '/repos/other/.git',
    };
    const cache = new Map([
      [forgePrCacheKey(otherRepoPr.repoCommonDir, otherRepoPr.branch), otherRepoPr],
    ]);

    expect(lookupThreadForgePr(THREAD, branchLookup(), cache)).toBeNull();
  });
});
