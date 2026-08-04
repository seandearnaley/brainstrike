import { beforeEach, describe, expect, it } from 'vitest';
import { useChangesNavigationStore } from '../changes-navigation-store';

describe('useChangesNavigationStore', () => {
  beforeEach(() => {
    useChangesNavigationStore.setState({ pendingChangeset: null });
  });

  it('starts with no pending changeset', () => {
    expect(useChangesNavigationStore.getState().pendingChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().consumePendingChangeset()).toBeNull();
  });

  it('returns the requested changeset once, then null on every later consume (clear-on-consume)', () => {
    const changeset = { kind: 'agent-run' as const, runId: 'run-1', threadId: 'thread-1' };
    useChangesNavigationStore.getState().requestChangeset(changeset);
    expect(useChangesNavigationStore.getState().pendingChangeset).toEqual(changeset);

    expect(useChangesNavigationStore.getState().consumePendingChangeset()).toEqual(changeset);
    expect(useChangesNavigationStore.getState().pendingChangeset).toBeNull();
    expect(useChangesNavigationStore.getState().consumePendingChangeset()).toBeNull();
    expect(useChangesNavigationStore.getState().consumePendingChangeset()).toBeNull();
  });

  it('a later request overwrites an unconsumed pending changeset', () => {
    const first = { kind: 'agent-run' as const, runId: 'run-1', threadId: 'thread-1' };
    const second = { kind: 'agent-run' as const, runId: 'run-2', threadId: 'thread-1' };
    useChangesNavigationStore.getState().requestChangeset(first);
    useChangesNavigationStore.getState().requestChangeset(second);
    expect(useChangesNavigationStore.getState().consumePendingChangeset()).toEqual(second);
  });
});
