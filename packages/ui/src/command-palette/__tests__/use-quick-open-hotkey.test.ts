import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuickOpenHotkey } from '../use-quick-open-hotkey';

const originalPlatform = navigator.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: platform,
  });
}

function dispatchKey(init: KeyboardEventInit & { target?: HTMLElement }): KeyboardEvent {
  const { target, ...eventInit } = init;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...eventInit });
  if (target) {
    target.dispatchEvent(event);
  } else {
    document.dispatchEvent(event);
  }
  return event;
}

describe('useQuickOpenHotkey', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  describe('on macOS (⌘P accelerator)', () => {
    it('opens on Cmd+P', () => {
      setPlatform('MacIntel');
      const onOpen = vi.fn();
      renderHook(() => useQuickOpenHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'p', metaKey: true });
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('opens on Cmd+P even when a text input is focused', () => {
      setPlatform('MacIntel');
      const onOpen = vi.fn();
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      renderHook(() => useQuickOpenHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'p', metaKey: true, target: input });
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('does NOT open on Ctrl+P (the cross-platform modifier is rejected on macOS)', () => {
      setPlatform('MacIntel');
      const onOpen = vi.fn();
      renderHook(() => useQuickOpenHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'p', ctrlKey: true });
      });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('on Windows/Linux (Ctrl+P accelerator)', () => {
    it('opens on Ctrl+P', () => {
      setPlatform('Win32');
      const onOpen = vi.fn();
      renderHook(() => useQuickOpenHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'p', ctrlKey: true });
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('does NOT open on Cmd+P (the cross-platform modifier is rejected)', () => {
      setPlatform('Win32');
      const onOpen = vi.fn();
      renderHook(() => useQuickOpenHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'p', metaKey: true });
      });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  it('opens on an uppercase P (case-insensitive)', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useQuickOpenHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'P', metaKey: true });
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('preventDefault()s the event so the browser print dialog does not fire', () => {
    // ⌘P is the browser's print shortcut; the in-app accelerator preventDefaults
    // so quick-open opens instead — the same trade-off the app makes for ⌘K.
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useQuickOpenHotkey({ onOpen }));
    let event: KeyboardEvent | undefined;
    act(() => {
      event = dispatchKey({ key: 'p', metaKey: true });
    });
    expect(event?.defaultPrevented).toBe(true);
  });

  it('ignores the keystroke when it was already defaultPrevented', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useQuickOpenHotkey({ onOpen }));
    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault();
      document.dispatchEvent(event);
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores plain p without a modifier', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useQuickOpenHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'p' });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useQuickOpenHotkey({ onOpen }));
    unmount();
    act(() => {
      dispatchKey({ key: 'p', metaKey: true });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
