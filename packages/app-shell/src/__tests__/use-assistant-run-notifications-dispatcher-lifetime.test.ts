import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAssistantRunNotifications } from '../use-assistant-run-notifications';

/**
 * The dispatcher coalesces per run per event kind, which is only meaningful
 * within ONE instance. It must be built once for the panel's lifetime, not
 * built and discarded on every render (`useRef(create())` evaluates its
 * argument each time; React Doctor `rerender-lazy-ref-init`).
 */
const { createSpy } = vi.hoisted(() => ({ createSpy: vi.fn() }));
vi.mock(
  '@brainstrike/app-state/notifications/run-notification-dispatcher',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@brainstrike/app-state/notifications/run-notification-dispatcher')
      >();
    createSpy.mockImplementation(actual.createRunNotificationDispatcher);
    return { ...actual, createRunNotificationDispatcher: createSpy };
  }
);

describe('useAssistantRunNotifications dispatcher lifetime', () => {
  it('builds one dispatcher for the panel lifetime and keeps the callbacks stable across renders', () => {
    const { rerender, result } = renderHook(() => useAssistantRunNotifications());
    const firstCallbacks = result.current;

    rerender();
    rerender();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(firstCallbacks);
  });
});
