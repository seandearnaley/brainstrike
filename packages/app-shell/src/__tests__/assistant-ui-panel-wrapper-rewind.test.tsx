/**
 * BST-1115 smoke feedback: "Last Turn" as a live standing scope — this suite
 * was split out of `assistant-ui-panel-wrapper.test.tsx` whole (same harness,
 * every assertion intact) to keep that file under the test-file budget pinned
 * in `assistant-contract-boundary.test.ts`. The wiring under test now lives
 * in `changes/use-wrapper-rewind-wiring.ts`, composed by the wrapper.
 */
import './assistant-ui-panel-wrapper-test-support';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test } from 'vitest';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import { renderAssistantThreadPanel } from './assistant-ui-panel-wrapper-test-support';

// BST-1115 smoke feedback: "Last Turn" as a live standing scope. The
// wrapper is the ONLY thing that can learn "the active thread" — this
// suite asserts what it publishes into `useChangesNavigationStore`.
describe('publishes the standing active-thread identity (BST-1115)', () => {
  beforeEach(() => {
    useChangesNavigationStore.getState().reset();
  });

  test('publishes the thread with a null latestRunId on selection — no fabricated run history', async () => {
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');

    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
        latestRunId: null,
        threadId: 'thread-existing',
      });
    });
  });

  // "No thread selected" is unreachable through this harness's full render
  // path — `ensureResourceThreads` auto-creates a fresh thread the moment
  // the memory resource has zero rows (real app behavior: a workspace
  // always operates on SOME active thread once the panel mounts). The
  // `selectedMemoryThreadId ? {...} : null` guard this relies on is
  // covered directly by the picker's own unit tests (disabled when
  // `threadId` is `null`) and the store's `selectLastTurn` no-op test.

  test('advances latestRunId to the finished run, keeping the same thread', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
        latestRunId: null,
        threadId: 'thread-existing',
      });
    });

    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-finished'));
    });

    expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
      latestRunId: 'run-live',
      threadId: 'thread-existing',
    });
  });

  test('advances latestRunId on a failed run too', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity?.threadId).toBe(
        'thread-existing'
      );
    });

    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-failed'));
    });

    expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
      latestRunId: 'run-live',
      threadId: 'thread-existing',
    });
  });

  test('retargets the active changeset when a run finishes while the surface is on Last Turn', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity?.threadId).toBe(
        'thread-existing'
      );
    });

    // Simulate an EARLIER run already completing, then the user picking
    // "Last Turn" for it — mirrors the picker's own `selectLastTurn` call.
    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-finished'));
    });
    act(() => {
      useChangesNavigationStore.getState().selectLastTurn();
    });
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'agent-run',
      runId: 'run-live',
      threadId: 'thread-existing',
    });
    expect(useChangesNavigationStore.getState().isOnLastTurn).toBe(true);

    // The wrapper's mock always reports the SAME runId ('run-live'), so
    // simulate a genuinely NEW run finishing directly through the store
    // action the wrapper itself calls, verifying the retarget applies.
    act(() => {
      useChangesNavigationStore
        .getState()
        .setActiveThreadIdentity({ latestRunId: 'run-live-2', threadId: 'thread-existing' });
    });

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'agent-run',
      runId: 'run-live-2',
      threadId: 'thread-existing',
    });
  });

  test('retargets to the run that just STARTED, not only at run.finished', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity?.threadId).toBe(
        'thread-existing'
      );
    });
    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-finished'));
    });
    act(() => {
      useChangesNavigationStore.getState().selectLastTurn();
    });

    // A NEW run beginning must move the view onto it immediately, so the
    // user watches the turn fill in instead of the previous one.
    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-started'));
    });

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'agent-run',
      runId: 'run-live-next',
      threadId: 'thread-existing',
    });
  });

  test('asks for a live re-resolve when a file-mutation tool completes mid-run', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity?.threadId).toBe(
        'thread-existing'
      );
    });
    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-finished'));
    });
    act(() => {
      useChangesNavigationStore.getState().selectLastTurn();
    });
    const before = useChangesNavigationStore.getState().liveRefreshNonce;

    await act(async () => {
      await user.click(screen.getByTestId('trigger-edit-tool-completed'));
    });

    // Leading edge fires immediately — the first completion of a burst must
    // not wait out the throttle window.
    expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(before + 1);
  });

  test('does NOT ask for a live re-resolve while a git scope is pinned', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity?.threadId).toBe(
        'thread-existing'
      );
    });
    act(() => {
      useChangesNavigationStore.getState().requestChangeset({
        kind: 'git-scope',
        repositoryRoot: '/repo',
        scope: { kind: 'uncommitted' },
        worktreePath: '/repo',
      });
    });
    const before = useChangesNavigationStore.getState().liveRefreshNonce;

    await act(async () => {
      await user.click(screen.getByTestId('trigger-edit-tool-completed'));
    });

    expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(before);
  });

  test('does NOT retarget a pinned git-scope changeset when a run finishes', async () => {
    const user = userEvent.setup();
    await renderAssistantThreadPanel(['openai'], 'thread-existing');
    await screen.findByTestId('assistant-ui-panel');
    await waitFor(() => {
      expect(useChangesNavigationStore.getState().activeThreadIdentity?.threadId).toBe(
        'thread-existing'
      );
    });

    const gitScope = {
      kind: 'git-scope' as const,
      repositoryRoot: '/repo',
      scope: { kind: 'uncommitted' as const },
      worktreePath: '/repo',
    };
    act(() => {
      useChangesNavigationStore.getState().requestChangeset(gitScope);
    });

    await act(async () => {
      await user.click(screen.getByTestId('trigger-run-finished'));
    });

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual(gitScope);
  });
});
