import type { Changeset } from '@brainstrike/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChangesNavigationStore } from '../changes-navigation-store';

const AGENT_RUN: Changeset = { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' };
const LATER_RUN: Changeset = { kind: 'agent-run', runId: 'run-2', threadId: 'thread-1' };
const GIT_SCOPE: Changeset = {
  kind: 'git-scope',
  repositoryRoot: '/repo',
  scope: { kind: 'uncommitted' },
  worktreePath: '/repo',
};

describe('useChangesNavigationStore', () => {
  beforeEach(() => {
    useChangesNavigationStore.setState({ activeChangeset: null, handoffThreadIdentity: null });
  });

  it('starts with nothing selected', () => {
    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toBeNull();
  });

  it('makes a requested changeset the active one', () => {
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
  });

  it('records the thread identity an agent-run handoff carried', () => {
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toEqual({
      latestRunId: 'run-1',
      threadId: 'thread-1',
    });
  });

  it('keeps that identity after the user moves on to a git scope', () => {
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);
    useChangesNavigationStore.getState().requestChangeset(GIT_SCOPE);

    // The active changeset follows the user; the identity deliberately
    // outlives it so "Last Turn" and run-range selection stay offerable.
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(GIT_SCOPE);
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toEqual({
      latestRunId: 'run-1',
      threadId: 'thread-1',
    });
  });

  it('never synthesises an identity from a git-scope changeset', () => {
    useChangesNavigationStore.getState().requestChangeset(GIT_SCOPE);

    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toBeNull();
  });

  it('advances the identity to the newest agent-run handoff', () => {
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);
    useChangesNavigationStore.getState().requestChangeset(LATER_RUN);

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(LATER_RUN);
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toEqual({
      latestRunId: 'run-2',
      threadId: 'thread-1',
    });
  });

  it('re-applies the same changeset on a repeat request (a second "Review" click)', () => {
    // The old pending/consume shape swallowed this: the first click consumed
    // and cleared the value, and a later identical request looked like nothing
    // had changed. One owned value has no such edge.
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);
    useChangesNavigationStore.getState().requestChangeset(GIT_SCOPE);
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
  });
});
