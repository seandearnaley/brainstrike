import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunNotificationDispatcher } from '../notifications/run-notification-dispatcher';
import type { NotificationEventToggles } from '../stores/notification-preferences-store';

const baseSettings = {
  events: allEventsOn(),
  masterEnabled: true,
};

function createHarness(overrides?: {
  settings?: typeof baseSettings;
  permissionState?: 'granted' | 'denied' | 'default' | 'unsupported';
  appActive?: boolean;
}) {
  const closeSpy = vi.fn();
  const constructed: Array<{ title: string; options: NotificationOptions | undefined }> = [];
  const notificationInstances: Array<{ onclick: (() => void) | null; close: () => void }> = [];

  const notificationFactory = vi.fn((title: string, options?: NotificationOptions) => {
    constructed.push({ options, title });
    const instance = { close: closeSpy, onclick: null as (() => void) | null };
    notificationInstances.push(instance);
    return instance;
  });

  const focusWindow = vi.fn();

  const dispatcher = createRunNotificationDispatcher({
    focusWindow,
    getPermissionState: () => overrides?.permissionState ?? 'granted',
    getSettings: () => overrides?.settings ?? baseSettings,
    isAppActive: () => overrides?.appActive ?? false,
    notificationFactory,
  });

  return {
    closeSpy,
    constructed,
    dispatcher,
    focusWindow,
    notificationFactory,
    notificationInstances,
  };
}

function allEventsOn(): NotificationEventToggles {
  return {
    prChecks: true,
    prOpened: true,
    runFailed: true,
    runFinished: true,
    toolApprovalRequired: true,
  };
}

function createTestDispatcher(overrides: {
  events: NotificationEventToggles;
  masterEnabled: boolean;
}) {
  const harness = createHarness({ settings: overrides });
  return { dispatcher: harness.dispatcher, notifications: harness.constructed };
}

describe('createRunNotificationDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs a Notification when unfocused, permitted, and enabled', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });

    expect(harness.notificationFactory).toHaveBeenCalledTimes(1);
  });

  it('never constructs a Notification for a focused window', () => {
    const harness = createHarness({ appActive: true });
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    expect(harness.notificationFactory).not.toHaveBeenCalled();
  });

  it('reads the app-active signal at dispatch time, not at construction', () => {
    let appActive = true;
    const notificationFactory = vi.fn(() => ({ close: vi.fn(), onclick: null }));
    const dispatcher = createRunNotificationDispatcher({
      getPermissionState: () => 'granted',
      getSettings: () => baseSettings,
      isAppActive: () => appActive,
      notificationFactory,
    });

    dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    expect(notificationFactory).not.toHaveBeenCalled();

    appActive = false;
    dispatcher.dispatch({ kind: 'runFinished', runId: 'run-2' });
    expect(notificationFactory).toHaveBeenCalledTimes(1);
  });

  it('never constructs a Notification when permission is denied', () => {
    const harness = createHarness({ permissionState: 'denied' });
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    expect(harness.notificationFactory).not.toHaveBeenCalled();
  });

  it('never constructs a Notification when the master toggle is off', () => {
    const harness = createHarness({ settings: { ...baseSettings, masterEnabled: false } });
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    expect(harness.notificationFactory).not.toHaveBeenCalled();
  });

  it('coalesces: at most one notification per run per event kind', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });

    expect(harness.notificationFactory).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce across different event kinds for the same run', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    harness.dispatcher.dispatch({ kind: 'runFailed', runId: 'run-1' });

    expect(harness.notificationFactory).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce across different runs for the same event kind', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-2' });

    expect(harness.notificationFactory).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated approvals for the same run + tool call to one notification', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({
      decisionKey: 'call-1',
      kind: 'toolApprovalRequired',
      runId: 'run-1',
    });
    harness.dispatcher.dispatch({
      decisionKey: 'call-1',
      kind: 'toolApprovalRequired',
      runId: 'run-1',
    });

    expect(harness.notificationFactory).toHaveBeenCalledTimes(1);
  });

  it('notifies again for a distinct approval in the same run (different decisionKey)', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({
      decisionKey: 'call-1',
      kind: 'toolApprovalRequired',
      runId: 'run-1',
    });
    harness.dispatcher.dispatch({
      decisionKey: 'call-2',
      kind: 'toolApprovalRequired',
      runId: 'run-1',
    });

    expect(harness.notificationFactory).toHaveBeenCalledTimes(2);
  });

  it('clicking the notification focuses the window', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });

    const instance = harness.notificationInstances[0];
    expect(instance).toBeDefined();
    instance?.onclick?.();

    expect(harness.focusWindow).toHaveBeenCalledTimes(1);
  });

  it('never includes message content or tool args in the notification body', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({
      decisionKey: 'call-1',
      kind: 'toolApprovalRequired',
      // @ts-expect-error -- intentionally passing a field the event contract
      // does not declare, to prove the dispatcher cannot leak it even if a
      // future caller mistakenly attaches one.
      messageText: 'the secret model output',
      runId: 'run-1',
      toolArgs: { apiKey: 'sk-should-never-appear' },
    });

    const [call] = harness.constructed;
    expect(call).toBeDefined();
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain('secret model output');
    expect(serialized).not.toContain('sk-should-never-appear');
  });

  it('builds short, privacy-safe copy per event kind, preferring the thread title', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({
      kind: 'runFinished',
      runId: 'run-1',
      threadTitle: 'Refactor plan',
    });
    harness.dispatcher.dispatch({ kind: 'runFailed', runId: 'run-2' });
    harness.dispatcher.dispatch({
      decisionKey: 'call-1',
      kind: 'toolApprovalRequired',
      runId: 'run-3',
    });

    expect(harness.constructed[0]?.title).toBe('Refactor plan');
    expect(harness.constructed[0]?.options?.body).toMatch(/finished/i);

    expect(harness.constructed[1]?.title).toBe('Assistant');
    expect(harness.constructed[1]?.options?.body).toMatch(/failed/i);

    expect(harness.constructed[2]?.title).toBe('Assistant');
    expect(harness.constructed[2]?.options?.body).toMatch(/approval/i);
  });

  it('resetCoalescing forgets prior dispatches so a repeated event can notify again', () => {
    const harness = createHarness();
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });
    harness.dispatcher.resetCoalescing();
    harness.dispatcher.dispatch({ kind: 'runFinished', runId: 'run-1' });

    expect(harness.notificationFactory).toHaveBeenCalledTimes(2);
  });
});

describe('forge notifications', () => {
  it('notifies once per observation key for an opened pull request', () => {
    const { dispatcher, notifications } = createTestDispatcher({
      events: { ...allEventsOn(), prOpened: true },
      masterEnabled: true,
    });
    dispatcher.dispatch({ kind: 'prOpened', observationKey: 'r/b/sha1', prNumber: 42 });
    dispatcher.dispatch({ kind: 'prOpened', observationKey: 'r/b/sha1', prNumber: 42 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.options?.body).toBe('Opened pull request #42.');
  });

  it('re-notifies when a new head produces a new observation key', () => {
    const { dispatcher, notifications } = createTestDispatcher({
      events: { ...allEventsOn(), prChecks: true },
      masterEnabled: true,
    });
    dispatcher.dispatch({
      checksOutcome: 'failing',
      kind: 'prChecks',
      observationKey: 'r/b/sha1',
      prNumber: 42,
    });
    dispatcher.dispatch({
      checksOutcome: 'passing',
      kind: 'prChecks',
      observationKey: 'r/b/sha2',
      prNumber: 42,
    });
    expect(notifications.map((entry) => entry.options?.body)).toEqual([
      'Checks failed on pull request #42.',
      'Checks passed on pull request #42.',
    ]);
  });

  it('respects the per-kind toggle', () => {
    const { dispatcher, notifications } = createTestDispatcher({
      events: { ...allEventsOn(), prOpened: false },
      masterEnabled: true,
    });
    dispatcher.dispatch({ kind: 'prOpened', observationKey: 'r/b/sha1', prNumber: 42 });
    expect(notifications).toHaveLength(0);
  });
});
