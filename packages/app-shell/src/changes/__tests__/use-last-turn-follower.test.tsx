/**
 * The shared "Last Turn" follower publishes a thread's activation run when the
 * thread becomes active (a host thread's newest committed run; legacy threads
 * pass null and are covered by `assistant-ui-panel-wrapper-rewind.test.tsx`),
 * and never for a mounted thread that is not the active one (BST-1268).
 */
import {
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useChangesNavigationStore } from '../changes-navigation-store';
import { useLastTurnFollower } from '../use-last-turn-follower';

beforeEach(() => {
  useChangesNavigationStore.getState().reset();
  resetAssistantThreadStore();
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-active' },
  });
});

test('the active thread publishes its activation run, and later runs as they start', () => {
  const { result } = renderHook(() => useLastTurnFollower('thread-active', 'run-7'));
  expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
    latestRunId: 'run-7',
    threadId: 'thread-active',
  });
  act(() => result.current.publishRun('run-8'));
  expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
    latestRunId: 'run-8',
    threadId: 'thread-active',
  });
});

test('a mounted thread that is not the active one publishes nothing', () => {
  const { result } = renderHook(() => useLastTurnFollower('thread-hidden', 'run-3'));
  act(() => result.current.publishRun('run-4'));
  expect(useChangesNavigationStore.getState().activeThreadIdentity).toBeNull();
});
