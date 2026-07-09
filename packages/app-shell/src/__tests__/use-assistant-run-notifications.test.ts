import {
  __resetNotificationPreferencesStoreForTests,
  useNotificationPreferencesStore,
} from '@brainstrike/preferences/stores/notification-preferences-store';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantRunNotifications } from '../use-assistant-run-notifications';

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
  let hasFocusSpy: ReturnType<typeof vi.spyOn>;
  let visibilityStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetNotificationPreferencesStoreForTests();
    hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    visibilityStateSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  });

  afterEach(() => {
    hasFocusSpy.mockRestore();
    visibilityStateSpy.mockRestore();
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

  it('ignores a run event with no runId (cannot be attributed to a run)', () => {
    const { NotificationMock } = stubNotification();
    useNotificationPreferencesStore.getState().setMasterEnabled(true);

    const { result } = renderHook(() => useAssistantRunNotifications());
    result.current.onRunFinished({
      id: 'e1',
      kind: 'run.finished',
      label: 'Done',
      status: 'completed',
      timestamp: '2026-07-09T00:00:00.000Z',
    });

    expect(NotificationMock).not.toHaveBeenCalled();
  });
});
