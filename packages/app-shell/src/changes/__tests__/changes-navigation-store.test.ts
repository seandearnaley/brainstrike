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
    useChangesNavigationStore.setState({
      activeChangeset: null,
      activeWorkspacePanelTab: 'context-explorer',
      changesTabMounted: false,
      handoffThreadIdentity: null,
    });
  });

  it('starts with nothing selected and Context Explorer active', () => {
    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toBeNull();
    expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('context-explorer');
    expect(useChangesNavigationStore.getState().changesTabMounted).toBe(false);
  });

  it('makes a requested changeset the active one', () => {
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
  });

  it('does NOT switch the workspace-panel tab on a plain requestChangeset call', () => {
    // The surface's own internal source picker calls this while already
    // visible — there is nothing to switch to.
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

    expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('context-explorer');
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

  it('reset() clears the active changeset, handoff identity, and workspace-panel tab', () => {
    useChangesNavigationStore.getState().openChangeset(AGENT_RUN);
    expect(useChangesNavigationStore.getState().activeChangeset).not.toBeNull();
    expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('changes');

    useChangesNavigationStore.getState().reset();

    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toBeNull();
    expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('context-explorer');
    expect(useChangesNavigationStore.getState().changesTabMounted).toBe(false);
  });

  describe('openChangeset', () => {
    it('sets the active changeset the same way requestChangeset does', () => {
      useChangesNavigationStore.getState().openChangeset(AGENT_RUN);

      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
      expect(useChangesNavigationStore.getState().handoffThreadIdentity).toEqual({
        latestRunId: 'run-1',
        threadId: 'thread-1',
      });
    });

    it('switches the workspace-panel tab to "changes" and marks it mounted, unlike a plain requestChangeset call', () => {
      useChangesNavigationStore.getState().openChangeset(AGENT_RUN);

      expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('changes');
      expect(useChangesNavigationStore.getState().changesTabMounted).toBe(true);
    });

    it('re-activates the "changes" tab on a second click for the SAME changeset, even after the user switched away', () => {
      useChangesNavigationStore.getState().openChangeset(AGENT_RUN);
      useChangesNavigationStore.getState().setActiveWorkspacePanelTab('context-explorer');
      expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('context-explorer');

      useChangesNavigationStore.getState().openChangeset(AGENT_RUN);

      expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('changes');
      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
    });
  });

  describe('setActiveWorkspacePanelTab', () => {
    it('switches tabs without touching the active changeset', () => {
      useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

      useChangesNavigationStore.getState().setActiveWorkspacePanelTab('changes');

      expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('changes');
      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
    });

    it('marks changesTabMounted sticky — it does not revert to false when switching back', () => {
      useChangesNavigationStore.getState().setActiveWorkspacePanelTab('changes');
      expect(useChangesNavigationStore.getState().changesTabMounted).toBe(true);

      useChangesNavigationStore.getState().setActiveWorkspacePanelTab('context-explorer');

      expect(useChangesNavigationStore.getState().changesTabMounted).toBe(true);
      expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('context-explorer');
    });
  });
});
