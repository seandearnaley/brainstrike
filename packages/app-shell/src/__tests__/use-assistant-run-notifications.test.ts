import {
  __resetNotificationPreferencesStoreForTests,
  useNotificationPreferencesStore,
} from '@brainstrike/app-state/stores/notification-preferences-store';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantRunNotifications } from '../use-assistant-run-notifications';
import { blurWindow, focusWindow, resetWindowActivity } from './window-activity-test-support';

function stubNotification() {
  const instances: Array<{ title: string; options: NotificationOptions }> = [];
  const NotificationMock = vi.fn(function (
    this: { onclick: (() => void) | null },
    title: string,
    options: NotificationOptions
  ) {
    instances.push({ options, title });
    this.onclick = null;
  }) as unknown as { new (title: string, options?: NotificationOptions): Notification } & {
    permission: string;
  };
  NotificationMock.permission = 'granted';
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: NotificationMock,
  });
  return { instances, NotificationMock };
}

describe('useAssistantRunNotifications', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

  // The gate reads the shared `isAppActive()`, which caches the window state and
  // re-reads it on window events, so the tests drive it the way a browser does.
  beforeEach(() => {
    __resetNotificationPreferencesStoreForTests();
    blurWindow();
  });

  afterEach(() => {
    resetWindowActivity();
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'Notification', originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }
    __resetNotificationPreferencesStoreForTests();
  });

  it('never notifies when the master toggle is off (the default)', () => {
    const { NotificationMock } = stubNotification();
    const { result } = renderHook(() => useAssistantRunNotifications());

    result.current.onRunFinished({
      id: 'e1',
      kind: 'run.finished',
      label: 'Done',
      runId: 'run-1',
      status: 'completed',
      timestamp: '2026-07-09T00:00:00.000Z',
    });

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('never notifies while the window is active, on the same signal as the unseen badge', () => {
    const { NotificationMock } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);
    const { result } = renderHook(() => useAssistantRunNotifications());
    const finished = (runId: string) => ({
      id: `e-${runId}`,
      kind: 'run.finished' as const,
      label: 'Done',
      runId,
      status: 'completed' as const,
      timestamp: '2026-07-09T00:00:00.000Z',
    });

    focusWindow();
    result.current.onRunFinished(finished('run-active'));
    expect(NotificationMock).not.toHaveBeenCalled();

    blurWindow();
    result.current.onRunFinished(finished('run-blurred'));
    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  it('notifies for run finished, run failed, and tool approval once master is enabled', () => {
    const { NotificationMock } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);

    const { result } = renderHook(() => useAssistantRunNotifications());

    result.current.onRunFinished({
      id: 'e1',
      kind: 'run.finished',
      label: 'Done',
      runId: 'run-1',
      status: 'completed',
      timestamp: '2026-07-09T00:00:00.000Z',
    });
    result.current.onRunFailed({
      id: 'e2',
      kind: 'run.failed',
      label: 'Failed',
      runId: 'run-2',
      status: 'failed',
      timestamp: '2026-07-09T00:00:00.000Z',
    });
    result.current.onToolApprovalRequired({
      runId: 'run-3',
      toolCallId: 'call-1',
      toolName: 'brainstrike.editFile',
    });

    expect(NotificationMock).toHaveBeenCalledTimes(3);
  });

  it('never includes tool args or message content in the notification body', () => {
    const { instances } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);

    const { result } = renderHook(() => useAssistantRunNotifications());
    result.current.onToolApprovalRequired({
      args: { secretPath: '/etc/should-not-leak' },
      runId: 'run-4',
      toolCallId: 'call-2',
      toolName: 'brainstrike.editFile',
    });

    const serialized = JSON.stringify(instances);
    expect(serialized).not.toContain('should-not-leak');
  });

  it('notifies distinct root runs that reuse a provider tool-call id', () => {
    const { NotificationMock } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);
    const { result } = renderHook(() => useAssistantRunNotifications());
    for (const runId of ['first-run', 'second-run']) {
      result.current.onToolApprovalRequired({
        runId,
        toolCallId: 'call_0',
        toolName: 'brainstrike.executeCommand',
      });
    }
    expect(NotificationMock).toHaveBeenCalledTimes(2);
  });

  it('alerts for each new child decision while coalescing its root and child copies', () => {
    const { NotificationMock } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);
    const { result } = renderHook(() => useAssistantRunNotifications());
    const request = {
      delegation: {
        path: [
          {
            childRuntimeRunId: 'child',
            parentRuntimeRunId: 'root',
            parentToolCallId: 'delegate',
            personaId: 'worker',
          },
        ],
        toolCallId: 'first-command',
      },
      runId: 'root',
      toolCallId: 'delegate',
      toolName: 'brainstrike.executeCommand',
    };
    result.current.onToolApprovalRequired(request);
    result.current.onToolApprovalRequired({
      ...request,
      runId: 'child',
      toolCallId: 'first-command',
    });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    // Both the decorated child projection and the native child request share the decision key.
    result.current.onToolApprovalRequired({
      runId: 'child',
      toolCallId: 'first-command',
      toolName: 'brainstrike.executeCommand',
    });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    result.current.onToolApprovalRequired({
      ...request,
      delegation: { ...request.delegation, toolCallId: 'second-command' },
    });
    expect(NotificationMock).toHaveBeenCalledTimes(2);
  });

  it('notifies a local run event that has no runId, coalescing on the event id', () => {
    // Web local-runtime events carry no runId (createLocalRunEvent assigns only
    // an event id). They must still notify; the stable event id is the honest
    // coalescing fallback (never a fabricated runId that could collide).
    const { NotificationMock } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);

    const { result } = renderHook(() => useAssistantRunNotifications());
    const localEvent = {
      id: 'local-run-event-abc',
      kind: 'run.finished' as const,
      label: 'Done',
      status: 'completed' as const,
      timestamp: '2026-07-09T00:00:00.000Z',
    };
    result.current.onRunFinished(localEvent);
    // A re-render/replay of the SAME local event must coalesce (event id key).
    result.current.onRunFinished(localEvent);

    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  it('notifies distinct local run events (different event ids) without collapsing', () => {
    const { NotificationMock } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);

    const { result } = renderHook(() => useAssistantRunNotifications());
    result.current.onRunFinished({
      id: 'local-run-event-1',
      kind: 'run.finished',
      label: 'Done',
      status: 'completed',
      timestamp: '2026-07-09T00:00:00.000Z',
    });
    result.current.onRunFailed({
      id: 'local-run-event-2',
      kind: 'run.failed',
      label: 'Failed',
      status: 'failed',
      timestamp: '2026-07-09T00:00:00.000Z',
    });

    expect(NotificationMock).toHaveBeenCalledTimes(2);
  });
});
