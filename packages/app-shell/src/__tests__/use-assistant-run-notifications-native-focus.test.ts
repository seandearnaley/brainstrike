import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BST-1864: the OS-notification gate and the unseen-badge rule (BST-1845) must
 * read ONE signal, `isAppActive()`, or a completion can be both "seen" and
 * "alerted". On desktop that signal is the NATIVE window's focus: keyboard focus
 * inside the browser pane's `WebContentsView` makes the renderer's
 * `document.hasFocus()` false while the window is still the focused OS window,
 * so a gate reading `document.hasFocus()` alerts about a thread the user is
 * looking at.
 *
 * `use-app-active` keeps module-scope state seeded from `window.windowFocus`
 * at import, so every case installs the bridge and then imports FRESH modules.
 */
const FINISHED_EVENT: AssistantRunEvent = {
  id: 'e1',
  kind: 'run.finished',
  label: 'Done',
  runId: 'run-1',
  status: 'completed',
  timestamp: '2026-09-28T00:00:00.000Z',
};

interface FakeWindowFocus {
  readonly emit: (focused: boolean) => void;
}

function installWindowFocus(initiallyFocused: boolean): FakeWindowFocus {
  const listeners = new Set<(focused: boolean) => void>();
  Object.defineProperty(window, 'windowFocus', {
    configurable: true,
    value: {
      isFocused: () => Promise.resolve(initiallyFocused),
      onChange: (callback: (focused: boolean) => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
  });
  return {
    emit: (focused) => {
      for (const listener of listeners) {
        listener(focused);
      }
    },
  };
}

/**
 * `hasFocus` is a spy, restored by `vi.restoreAllMocks()` (assigning
 * `document.hasFocus` would leave an own property behind); the `hidden` and
 * `visibilityState` overrides are deleted in `afterEach`.
 */
function setDocument({ focused }: { readonly focused: boolean }): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

function stubNotification(): ReturnType<typeof vi.fn> {
  const NotificationMock = vi.fn(function (this: { onclick: (() => void) | null }) {
    this.onclick = null;
  }) as unknown as ReturnType<typeof vi.fn> & { permission: string };
  NotificationMock.permission = 'granted';
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: NotificationMock,
  });
  return NotificationMock;
}

async function mountHook() {
  const { useNotificationPreferencesStore } = await import(
    '@brainstrike/app-state/stores/notification-preferences-store'
  );
  useNotificationPreferencesStore.getState().setMasterEnabled(true);
  const { useAssistantRunNotifications } = await import('../use-assistant-run-notifications');
  const { result } = renderHook(() => useAssistantRunNotifications());
  // Lets the bridge's initial `isFocused()` read settle inside `use-app-active`.
  await Promise.resolve();
  await Promise.resolve();
  return result;
}

describe('useAssistantRunNotifications on the native window-focus signal', () => {
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'windowFocus');
    Reflect.deleteProperty(document, 'hidden');
    Reflect.deleteProperty(document, 'visibilityState');
    if (originalNotification) {
      Object.defineProperty(globalThis, 'Notification', originalNotification);
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }
    vi.restoreAllMocks();
  });

  it('does not alert while the window is focused and keyboard focus is in the browser pane', async () => {
    setDocument({ focused: false });
    installWindowFocus(true);
    const NotificationMock = stubNotification();
    const result = await mountHook();

    result.current.onRunFinished(FINISHED_EVENT);

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('alerts when the native window is blurred, even if the document still reports focus', async () => {
    setDocument({ focused: true });
    installWindowFocus(false);
    const NotificationMock = stubNotification();
    const result = await mountHook();

    result.current.onRunFinished(FINISHED_EVENT);

    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  it('evaluates the gate at event time, not at mount', async () => {
    setDocument({ focused: false });
    const nativeFocus = installWindowFocus(true);
    const NotificationMock = stubNotification();
    const result = await mountHook();

    nativeFocus.emit(false);
    result.current.onRunFinished(FINISHED_EVENT);
    expect(NotificationMock).toHaveBeenCalledTimes(1);

    nativeFocus.emit(true);
    result.current.onRunFinished({ ...FINISHED_EVENT, id: 'e2', runId: 'run-2' });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  it('agrees with useAppActive() for every window state, so seen and alerted are exclusive', async () => {
    setDocument({ focused: false });
    const nativeFocus = installWindowFocus(true);
    const NotificationMock = stubNotification();
    const result = await mountHook();
    const { isAppActive } = await import('@brainstrike/hooks');

    for (const [index, focused] of [true, false, true, false].entries()) {
      nativeFocus.emit(focused);
      const before = NotificationMock.mock.calls.length;
      result.current.onRunFinished({ ...FINISHED_EVENT, id: `e-${index}`, runId: `run-${index}` });
      const alerted = NotificationMock.mock.calls.length > before;
      expect(alerted).toBe(!isAppActive());
    }
  });
});
