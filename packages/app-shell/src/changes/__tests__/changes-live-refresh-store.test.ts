import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectGitScopeRefreshNonce,
  useChangesLiveRefreshStore,
} from '../changes-live-refresh-store';

describe('useChangesLiveRefreshStore (BST-1161)', () => {
  beforeEach(() => {
    useChangesLiveRefreshStore.getState().reset();
  });

  it('bumps the any-invalidation nonce and ONLY the invalidated repo nonce on a mapped event', () => {
    const ingest = useChangesLiveRefreshStore.getState().ingestInvalidation;
    // Both repos become KNOWN keys, so the per-repo precision below is
    // exercised rather than the unknown-key conservative fallback.
    ingest({ generation: 1, gitCommonDir: '/repo-b/.git', repositoryRoot: '/repo-b' });
    ingest({ generation: 2, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });
    ingest({ generation: 3, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });

    const state = useChangesLiveRefreshStore.getState();
    expect(state.anyInvalidationNonce).toBe(3);
    expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(2);
    // Another KNOWN repo's git-scope view does not refetch on repo-a's
    // activity — its nonce reflects only its own event.
    expect(selectGitScopeRefreshNonce(state, '/repo-b')).toBe(1);
  });

  it('a repositoryRoot NEVER seen in any event follows the any-invalidation nonce — non-canonical path vocabulary must degrade to conservative refetch, never silent staleness (PR #2288 review)', () => {
    const ingest = useChangesLiveRefreshStore.getState().ingestInvalidation;
    ingest({ generation: 1, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });
    ingest({ generation: 2, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });

    const state = useChangesLiveRefreshStore.getState();
    // A changeset published with a different vocabulary for the SAME repo
    // (e.g. the git panel's un-realpath'd GitRepository.repositoryRoot vs the
    // inventory's canonical realpath) can never match the event key. It must
    // still observe every event rather than silently never refreshing.
    expect(selectGitScopeRefreshNonce(state, '/symlinked/repo-a')).toBe(2);
  });

  it('an unmapped event (repositoryRoot null) refreshes EVERY git-scope view, conservatively', () => {
    useChangesLiveRefreshStore.getState().ingestInvalidation({
      generation: 1,
      gitCommonDir: '/mystery/.git',
      repositoryRoot: null,
    });

    const state = useChangesLiveRefreshStore.getState();
    expect(state.anyInvalidationNonce).toBe(1);
    expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(1);
    expect(selectGitScopeRefreshNonce(state, '/repo-b')).toBe(1);
  });

  it('drops stale and duplicate wire generations without bumping anything', () => {
    const ingest = useChangesLiveRefreshStore.getState().ingestInvalidation;
    ingest({ generation: 3, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });
    // Duplicate delivery.
    ingest({ generation: 3, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });
    // Out-of-order older event.
    ingest({ generation: 2, gitCommonDir: '/repo-b/.git', repositoryRoot: '/repo-b' });

    const state = useChangesLiveRefreshStore.getState();
    expect(state.anyInvalidationNonce).toBe(1);
    expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(1);
  });

  it('accepts strictly increasing generations and tracks per-repo counts independently', () => {
    const ingest = useChangesLiveRefreshStore.getState().ingestInvalidation;
    ingest({ generation: 1, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });
    ingest({ generation: 2, gitCommonDir: '/repo-b/.git', repositoryRoot: '/repo-b' });
    ingest({ generation: 3, gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' });

    const state = useChangesLiveRefreshStore.getState();
    expect(state.anyInvalidationNonce).toBe(3);
    expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(2);
    expect(selectGitScopeRefreshNonce(state, '/repo-b')).toBe(1);
  });

  it('reset() restores the initial state (factory-reset invariant)', () => {
    useChangesLiveRefreshStore.getState().ingestInvalidation({
      generation: 5,
      gitCommonDir: '/repo-a/.git',
      repositoryRoot: '/repo-a',
    });

    useChangesLiveRefreshStore.getState().reset();

    const state = useChangesLiveRefreshStore.getState();
    expect(state.anyInvalidationNonce).toBe(0);
    expect(selectGitScopeRefreshNonce(state, '/repo-a')).toBe(0);
    // After a reset the wire guard starts over: a main process restarted
    // alongside the reset re-numbers from 1, which must not be dropped.
    useChangesLiveRefreshStore.getState().ingestInvalidation({
      generation: 1,
      gitCommonDir: '/repo-a/.git',
      repositoryRoot: '/repo-a',
    });
    expect(useChangesLiveRefreshStore.getState().anyInvalidationNonce).toBe(1);
  });
});
