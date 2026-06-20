import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCommandPaletteHotkey } from '../use-command-palette-hotkey';

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
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('opens on Cmd+K', () => {
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'k', metaKey: true });
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens on Ctrl+K', () => {
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'k', ctrlKey: true });
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens on an uppercase K (case-insensitive)', () => {
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'K', metaKey: true });
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('preventDefault()s the event so the browser shortcut does not fire', () => {
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    let event: KeyboardEvent | undefined;
    act(() => {
      event = dispatchKey({ key: 'k', metaKey: true });
    });
    expect(event?.defaultPrevented).toBe(true);
  });

  it('ignores the keystroke when it was already defaultPrevented', () => {
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
    const onOpen = vi.fn();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'k' });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores the keystroke when a text input is focused', () => {
    const onOpen = vi.fn();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'k', metaKey: true, target: input });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores the keystroke when a textarea is focused', () => {
    const onOpen = vi.fn();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'k', metaKey: true, target: textarea });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores the keystroke when a contenteditable element is focused', () => {
    const onOpen = vi.fn();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    // happy-dom reads isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.appendChild(editable);
    renderHook(() => useCommandPaletteHotkey({ onOpen }));
    act(() => {
      dispatchKey({ key: 'k', metaKey: true, target: editable });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useCommandPaletteHotkey({ onOpen }));
    unmount();
    act(() => {
      dispatchKey({ key: 'k', metaKey: true });
    });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
