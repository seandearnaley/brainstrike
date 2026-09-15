import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
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
      activeThreadIdentity: null,
      focusedCanvasId: null,
      handoffThreadIdentity: null,
      isOnLastTurn: false,
    });
    __resetWorkspaceTabSelectionStoreForTests();
  });

  it('starts with nothing selected', () => {
    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toBeNull();
  });

  it('makes a requested changeset the active one', () => {
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
  });

  it('does NOT open the Changes workspace tab on a plain requestChangeset call', () => {
    // The surface's own internal source picker calls this while already
    // visible — there is nothing to switch to.
    useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);

    expect(useWorkspaceTabSelectionStore.getState().openAppIds).not.toContain('changes');
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

  it('reset() clears the active changeset and handoff identity', () => {
    useChangesNavigationStore.getState().openChangeset(AGENT_RUN);
    expect(useChangesNavigationStore.getState().activeChangeset).not.toBeNull();

    useChangesNavigationStore.getState().reset();

    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().handoffThreadIdentity).toBeNull();
  });

  it('reset() also clears the standing active-thread identity and the "on Last Turn" flag', () => {
    useChangesNavigationStore.setState({
      activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
    });
    useChangesNavigationStore.getState().selectLastTurn();
    expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(true);

    useChangesNavigationStore.getState().reset();

    expect(useChangesNavigationStore.getState().activeThreadIdentity).toBeNull();
    expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);
  });

  // BST-1115 smoke feedback: "Last Turn" as a live standing scope.
  describe('activeThreadIdentity / selectLastTurn / setActiveThreadIdentity', () => {
    it('starts null', () => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity).toBeNull();
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);
    });

    it('setActiveThreadIdentity publishes the identity as-is when the user is not on Last Turn', () => {
      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: null, threadId: 'thread-1' });

      expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
        latestRunId: null,
        threadId: 'thread-1',
      });
      expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    });

    it('selectLastTurn resolves the CURRENT identity into an agent-run changeset and sets isOnLastTurn', () => {
      useChangesNavigationStore.setState({
        activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
      });

      useChangesNavigationStore.getState().selectLastTurn();

      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(true);
      // Same write-through as any agent-run requestChangeset — the handoff
      // field's own semantics are untouched.
      expect(useChangesNavigationStore.getState().handoffThreadIdentity).toEqual({
        latestRunId: 'run-1',
        threadId: 'thread-1',
      });
    });

    it('selectLastTurn is a no-op (no fabrication) when the thread has no completed runs yet', () => {
      useChangesNavigationStore.setState({
        activeThreadIdentity: { latestRunId: null, threadId: 'thread-1' },
      });

      useChangesNavigationStore.getState().selectLastTurn();

      expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);
    });

    it('selectLastTurn is a no-op when no thread is active', () => {
      useChangesNavigationStore.getState().selectLastTurn();

      expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);
    });

    it('a plain requestChangeset call (e.g. picking a git scope) clears isOnLastTurn', () => {
      useChangesNavigationStore.setState({
        activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
      });
      useChangesNavigationStore.getState().selectLastTurn();
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(true);

      useChangesNavigationStore.getState().requestChangeset(GIT_SCOPE);

      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);
    });

    it('retargets the active changeset to the new run when a fresh run finishes while on Last Turn', () => {
      useChangesNavigationStore.setState({
        activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
      });
      useChangesNavigationStore.getState().selectLastTurn();
      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);

      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-2', threadId: 'thread-1' });

      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(LATER_RUN);
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(true);
      expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
        latestRunId: 'run-2',
        threadId: 'thread-1',
      });
    });

    it('never retargets a git-scope changeset even while a NEW run finishes', () => {
      useChangesNavigationStore.setState({
        activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
      });
      useChangesNavigationStore.getState().selectLastTurn();
      useChangesNavigationStore.getState().requestChangeset(GIT_SCOPE);
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);

      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-2', threadId: 'thread-1' });

      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(GIT_SCOPE);
    });

    it('never retargets a specific run the user explicitly pinned, even if it was the latest at pin time', () => {
      // The user picks Last Turn (run-1 is latest), THEN it stops being
      // "Last Turn" once they re-pick that exact run via a plain
      // requestChangeset call (e.g. a run-range/specific-run control) — id
      // equality with the new latestRunId must never resurrect live tracking.
      useChangesNavigationStore.setState({
        activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
      });
      useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);
      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);

      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-2', threadId: 'thread-1' });

      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
    });

    it('does not retarget across a different thread than the pinned changeset', () => {
      useChangesNavigationStore.setState({
        activeThreadIdentity: { latestRunId: 'run-1', threadId: 'thread-1' },
      });
      useChangesNavigationStore.getState().selectLastTurn();

      // A run finished on a DIFFERENT thread — must never bleed into this one.
      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-9', threadId: 'thread-other' });

      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
    });
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

    it('opens and activates the Changes workspace app tab, unlike a plain requestChangeset call', () => {
      useChangesNavigationStore.getState().openChangeset(AGENT_RUN);

      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toContain('changes');
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'changes',
        kind: 'app',
      });
    });

    it('re-activates the Changes tab on a second click for the SAME changeset, even after the user switched away', () => {
      useChangesNavigationStore.getState().openChangeset(AGENT_RUN);
      useWorkspaceTabSelectionStore.getState().selectApp('context-explorer');

      useChangesNavigationStore.getState().openChangeset(AGENT_RUN);

      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'changes',
        kind: 'app',
      });
      expect(useChangesNavigationStore.getState().activeChangeset).toEqual(AGENT_RUN);
    });
  });

  describe('openCanvasPanel', () => {
    it('opens and activates the Canvas workspace app tab', () => {
      useChangesNavigationStore.getState().openCanvasPanel();

      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toContain('canvas');
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
    });
  });

  describe('openCanvas / selectCanvas', () => {
    it('openCanvas focuses the canvas AND opens the Canvas workspace app tab', () => {
      useChangesNavigationStore.getState().openCanvas('canvas-7');

      expect(useChangesNavigationStore.getState().focusedCanvasId).toBe('canvas-7');
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).toContain('canvas');
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'canvas',
        kind: 'app',
      });
    });

    it('selectCanvas focuses without touching the workspace tab (the panel picker)', () => {
      useChangesNavigationStore.getState().selectCanvas('canvas-8');

      expect(useChangesNavigationStore.getState().focusedCanvasId).toBe('canvas-8');
      expect(useWorkspaceTabSelectionStore.getState().openAppIds).not.toContain('canvas');
    });

    it('reset clears the focused canvas (factory-reset invariant)', () => {
      useChangesNavigationStore.getState().selectCanvas('canvas-9');
      useChangesNavigationStore.getState().reset();
      expect(useChangesNavigationStore.getState().focusedCanvasId).toBeNull();
    });
  });

  describe('requestLiveLastTurnRefresh', () => {
    function arriveOnLastTurn(): void {
      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-1', threadId: 'thread-1' });
      useChangesNavigationStore.getState().selectLastTurn();
    }

    it('bumps the nonce while the surface is on THIS thread\u2019s Last Turn', () => {
      arriveOnLastTurn();
      const before = useChangesNavigationStore.getState().liveRefreshNonce;

      useChangesNavigationStore.getState().requestLiveLastTurnRefresh('thread-1');

      expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(before + 1);
    });

    it('is a no-op for a DIFFERENT thread\u2019s run', () => {
      arriveOnLastTurn();
      const before = useChangesNavigationStore.getState().liveRefreshNonce;

      useChangesNavigationStore.getState().requestLiveLastTurnRefresh('thread-other');

      expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(before);
    });

    it('is a no-op once the user pins a specific run (isOnLastTurn cleared)', () => {
      arriveOnLastTurn();
      useChangesNavigationStore.getState().requestChangeset(AGENT_RUN);
      const before = useChangesNavigationStore.getState().liveRefreshNonce;

      useChangesNavigationStore.getState().requestLiveLastTurnRefresh('thread-1');

      expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(false);
      expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(before);
    });

    it('is a no-op while a git scope is showing', () => {
      arriveOnLastTurn();
      useChangesNavigationStore.getState().requestChangeset(GIT_SCOPE);
      const before = useChangesNavigationStore.getState().liveRefreshNonce;

      useChangesNavigationStore.getState().requestLiveLastTurnRefresh('thread-1');

      expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(before);
    });
  });
});
