/** Current wrapper ownership after retirement of Main's tombstone finalizer. */
import {
  type AssistantRunEventKind,
  createAssistantRunEvent,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import {
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesNavigationStore } from '../changes-navigation-store';
import { useRewindStore } from '../rewind-store';
import { useWrapperRewindWiring } from '../use-wrapper-rewind-wiring';

const THREAD = 'thread-active';
function event(kind: AssistantRunEventKind, runId?: string, toolName?: string) {
  return createAssistantRunEvent({
    kind,
    label: kind,
    status: 'completed',
    ...(runId ? { runId } : {}),
    ...(toolName ? { metadata: { toolName } } : {}),
  });
}
function activate(threadId: string) {
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: threadId },
  });
}
function render(threadId: string | undefined = THREAD) {
  return renderHook(() => useWrapperRewindWiring({ threadId }));
}
beforeEach(() => {
  useChangesNavigationStore.getState().reset();
  useRewindStore.getState().reset();
  resetAssistantThreadStore();
  activate(THREAD);
});
afterEach(() => vi.useRealTimers());

describe('useWrapperRewindWiring — run-owned projection', () => {
  it('activates without inventing a completed run', () => {
    render();
    expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
      latestRunId: null,
      threadId: THREAD,
    });
  });
  it('publishes the observed run immediately and retargets Last Turn on the next start', () => {
    const { result } = render();
    act(() => result.current.handleRunEditActivity(event('run.started', 'run-1')));
    act(() => useChangesNavigationStore.getState().selectLastTurn());
    act(() => result.current.handleRunEditActivity(event('run.started', 'run-2')));
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'agent-run',
      runId: 'run-2',
      threadId: THREAD,
    });
  });
  it.each(['run.finished', 'run.failed'] as const)(
    'publishes %s without a legacy finalization command',
    (kind) => {
      const { result } = render();
      act(() => result.current.publishTerminalRunIdentity(event(kind, 'run-1')));
      expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
        latestRunId: 'run-1',
        threadId: THREAD,
      });
    }
  );
  it('does not invent a run ID for a terminal event without one', () => {
    const { result } = render();
    act(() => result.current.publishTerminalRunIdentity(event('run.finished')));
    expect(useChangesNavigationStore.getState().activeThreadIdentity?.latestRunId).toBeNull();
  });
  it('does not publish a hidden thread over the active thread', () => {
    render();
    const { result } = render('thread-background');
    act(() => result.current.handleRunEditActivity(event('run.started', 'background-run')));
    act(() => result.current.publishTerminalRunIdentity(event('run.finished', 'background-run')));
    expect(useChangesNavigationStore.getState().activeThreadIdentity).toEqual({
      latestRunId: null,
      threadId: THREAD,
    });
  });
  it('does not emit run or canvas activity without a thread', () => {
    const { result } = renderHook(() => useWrapperRewindWiring({ threadId: undefined }));
    act(() =>
      result.current.handleRunEditActivity(
        event('tool.completed', 'run-1', NATIVE_TOOL_ID.manageCanvas)
      )
    );
    expect(useChangesNavigationStore.getState().activeThreadIdentity).toBeNull();
    expect(useChangesNavigationStore.getState().canvasRefreshNonce).toBe(0);
  });
  it('preserves the leading and trailing edit refresh without replaying a run', () => {
    vi.useFakeTimers();
    const { result } = render();
    act(() => result.current.handleRunEditActivity(event('run.started', 'run-1')));
    act(() => useChangesNavigationStore.getState().selectLastTurn());
    const edit = event('tool.completed', 'run-1', NATIVE_TOOL_ID.writeWorkspaceFile);
    act(() => {
      result.current.handleRunEditActivity(edit);
      result.current.handleRunEditActivity(edit);
    });
    expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(2);
    expect(useChangesNavigationStore.getState().activeThreadIdentity?.latestRunId).toBe('run-1');
  });
  it('never refreshes an explicitly pinned earlier turn', () => {
    const { result } = render();
    act(() =>
      useChangesNavigationStore
        .getState()
        .requestChangeset({ kind: 'agent-run', runId: 'old-run', threadId: THREAD })
    );
    act(() =>
      result.current.handleRunEditActivity(
        event('tool.completed', 'run-1', NATIVE_TOOL_ID.writeWorkspaceFile)
      )
    );
    expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(0);
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'agent-run',
      runId: 'old-run',
      threadId: THREAD,
    });
  });
  it('refreshes Canvas only for the canonical canvas tool', () => {
    const { result } = render();
    act(() =>
      result.current.handleRunEditActivity(
        event('tool.completed', 'run-1', NATIVE_TOOL_ID.writeWorkspaceFile)
      )
    );
    expect(useChangesNavigationStore.getState().canvasRefreshNonce).toBe(0);
    act(() =>
      result.current.handleRunEditActivity(
        event('tool.completed', 'run-1', NATIVE_TOOL_ID.manageCanvas)
      )
    );
    expect(useChangesNavigationStore.getState().canvasRefreshNonce).toBe(1);
  });
  it('advances hydration on each durable branch change', () => {
    const { result } = render();
    expect(result.current.rewindGeneration).toBe(0);
    act(() => useRewindStore.getState().markRewindApplied());
    expect(result.current.rewindGeneration).toBe(1);
    act(() => useRewindStore.getState().markRewindApplied());
    expect(result.current.rewindGeneration).toBe(2);
  });
  it('joins refresh ownership on unmount so queued work does not refresh after disposal', () => {
    vi.useFakeTimers();
    const { result, unmount } = render();
    act(() => result.current.handleRunEditActivity(event('run.started', 'run-1')));
    act(() => useChangesNavigationStore.getState().selectLastTurn());
    const edit = event('tool.completed', 'run-1', NATIVE_TOOL_ID.writeWorkspaceFile);
    act(() => {
      result.current.handleRunEditActivity(edit);
      result.current.handleRunEditActivity(edit);
    });
    unmount();
    act(() => vi.advanceTimersByTime(500));
    expect(useChangesNavigationStore.getState().liveRefreshNonce).toBe(1);
  });
});
