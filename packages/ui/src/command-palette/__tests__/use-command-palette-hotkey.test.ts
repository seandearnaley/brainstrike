import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCommandPaletteHotkey } from '../use-command-palette-hotkey';

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

describe('useCommandPaletteHotkey', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  describe('on macOS (⌘K accelerator)', () => {
    it('opens on Cmd+K', () => {
      setPlatform('MacIntel');
      const onOpen = vi.fn();
      renderHook(() => useCommandPaletteHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'k', metaKey: true });
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('opens on Cmd+K even when a text input is focused', () => {
      // The platform accelerator is a non-character meta-chord, so it fires
      // regardless of focus — matching the desktop menu accelerator + VS Code/
      // Linear UX (no web/desktop divergence).
      setPlatform('MacIntel');
      const onOpen = vi.fn();
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      renderHook(() => useCommandPaletteHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'k', metaKey: true, target: input });
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('does NOT open on Ctrl+K (preserves the native kill-to-end-of-line binding)', () => {
      setPlatform('MacIntel');
      const onOpen = vi.fn();
      renderHook(() => useCommandPaletteHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'k', ctrlKey: true });
      });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('on Windows/Linux (Ctrl+K accelerator)', () => {
    it('opens on Ctrl+K', () => {
      setPlatform('Win32');
      const onOpen = vi.fn();
      renderHook(() => useCommandPaletteHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'k', ctrlKey: true });
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('opens on Ctrl+K even when a text input is focused', () => {
      setPlatform('Win32');
      const onOpen = vi.fn();
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      renderHook(() => useCommandPaletteHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'k', ctrlKey: true, target: input });
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('does NOT open on Cmd+K (the cross-platform modifier is rejected)', () => {
      setPlatform('Win32');
      const onOpen = vi.fn();
      renderHook(() => useCommandPaletteHotkey({ onOpen }));
      act(() => {
        dispatchKey({ key: 'k', metaKey: true });
      });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  it('opens on an uppercase K (case-insensitive)', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'K', metaKey: true });
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('preventDefault()s the event so the browser shortcut does not fire', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    let event: KeyboardEvent | undefined;
    act(() => {
      event = dispatchKey({ key: 'k', metaKey: true });
    });
    expect(event?.defaultPrevented).toBe(true);
  });

  it('ignores the keystroke when it was already defaultPrevented', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault();
      document.dispatchEvent(event);
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores plain k without a modifier', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'k' });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    setPlatform('MacIntel');
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useCommandPaletteHotkey({ onOpen }));
    unmount();
    act(() => {
      dispatchKey({ key: 'k', metaKey: true });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
