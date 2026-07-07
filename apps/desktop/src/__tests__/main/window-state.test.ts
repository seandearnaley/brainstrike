import type { BrowserWindow, Rectangle } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAllDisplays = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  screen: {
    getAllDisplays,
  },
}));

import {
  captureWindowState,
  ensureWindowBoundsVisible,
  getDefaultWindowState,
  readStoredWindowState,
  registerWindowStatePersistence,
  resolveInitialWindowState,
} from '../../window-state';

describe('window-state', () => {
  beforeEach(() => {
    getAllDisplays.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns default window state values', () => {
    const state = getDefaultWindowState();

    expect(state.isFullScreen).toBe(false);
    expect(state.isMaximized).toBe(true);
    expect(state.bounds.width).toBe(1536);
    expect(state.bounds.height).toBe(800);
  });

  it('resolves initial state from stored value', () => {
    const stored = {
      bounds: { height: 700, width: 900, x: 10, y: 20 },
      isFullScreen: false,
      isMaximized: false,
    };

    expect(resolveInitialWindowState(stored)).toEqual(stored);
    expect(resolveInitialWindowState(null)).toEqual(getDefaultWindowState());
  });

  it('clamps bounds when x/y are missing', () => {
    const workArea: Rectangle = { height: 700, width: 1000, x: 0, y: 0 };
    getAllDisplays.mockReturnValue([{ workArea }]);

    const state = ensureWindowBoundsVisible({
      bounds: { height: 1200, width: 2000 },
      isFullScreen: false,
      isMaximized: false,
    });

    expect(state.bounds.width).toBe(1000);
    expect(state.bounds.height).toBe(700);
  });

  it('falls back to default bounds when off-screen', () => {
    const workArea: Rectangle = { height: 600, width: 800, x: 0, y: 0 };
    getAllDisplays.mockReturnValue([{ workArea }]);

    const state = ensureWindowBoundsVisible({
      bounds: { height: 700, width: 900, x: 5000, y: 5000 },
      isFullScreen: false,
      isMaximized: false,
    });

    expect(state.bounds.width).toBe(800);
    expect(state.bounds.height).toBe(600);
  });

  it('clamps bounds within a visible display', () => {
    const workArea: Rectangle = { height: 800, width: 1000, x: 0, y: 0 };
    getAllDisplays.mockReturnValue([{ workArea }]);

    const state = ensureWindowBoundsVisible({
      bounds: { height: 400, width: 500, x: 900, y: 700 },
      isFullScreen: false,
      isMaximized: false,
    });

    expect(state.bounds.x).toBe(500);
    expect(state.bounds.y).toBe(400);
  });

  it('normalizes stored window state', () => {
    const store = {
      get: () => ({
        v1: {
          bounds: { height: 200, width: 200, x: 1, y: 2 },
          isFullScreen: true,
          isMaximized: true,
        },
      }),
    } as unknown;

    const state = readStoredWindowState(store as never);

    expect(state?.bounds.width).toBe(800);
    expect(state?.bounds.height).toBe(600);
    expect(state?.isFullScreen).toBe(true);
    expect(state?.isMaximized).toBe(false);
  });

  it('captures window state using normal bounds for maximized windows', () => {
    const win = {
      getBounds: vi.fn().mockReturnValue({ height: 400, width: 600, x: 1, y: 2 }),
      getNormalBounds: vi.fn().mockReturnValue({ height: 800, width: 1200, x: 5, y: 6 }),
      isFullScreen: vi.fn().mockReturnValue(false),
      isMaximized: vi.fn().mockReturnValue(true),
    } as unknown as BrowserWindow;

    const state = captureWindowState(win);

    expect(state.bounds.width).toBe(1200);
    expect(state.bounds.height).toBe(800);
    expect(state.isMaximized).toBe(true);
  });

  it('persists window state on debounced events', () => {
    vi.useFakeTimers();

    const listeners: Record<string, () => void> = {};
    const win = {
      getBounds: vi.fn().mockReturnValue({ height: 700, width: 900, x: 1, y: 2 }),
      getNormalBounds: vi.fn().mockReturnValue({ height: 700, width: 900, x: 1, y: 2 }),
      isDestroyed: vi.fn().mockReturnValue(false),
      isFullScreen: vi.fn().mockReturnValue(false),
      isMaximized: vi.fn().mockReturnValue(false),
      on: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
      removeListener: vi.fn(),
    } as unknown as BrowserWindow;

    const set = vi.fn();
    const store = { get: vi.fn(), set } as unknown as {
      get: () => unknown;
      set: (key: string, value: unknown) => void;
    };

    registerWindowStatePersistence(win, store as never);

    listeners['resize']?.();
    vi.advanceTimersByTime(250);

    expect(set).toHaveBeenCalledTimes(1);

    listeners['close']?.();
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('returns a disposer that removes every listener and clears the pending debounce', () => {
    vi.useFakeTimers();

    const listeners: Record<string, () => void> = {};
    const removeListener = vi.fn();
    const win = {
      getBounds: vi.fn().mockReturnValue({ height: 700, width: 900, x: 1, y: 2 }),
      getNormalBounds: vi.fn().mockReturnValue({ height: 700, width: 900, x: 1, y: 2 }),
      isDestroyed: vi.fn().mockReturnValue(false),
      isFullScreen: vi.fn().mockReturnValue(false),
      isMaximized: vi.fn().mockReturnValue(false),
      on: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
      removeListener,
    } as unknown as BrowserWindow;

    const set = vi.fn();
    const store = { get: vi.fn(), set } as unknown as {
      get: () => unknown;
      set: (key: string, value: unknown) => void;
    };

    const dispose = registerWindowStatePersistence(win, store as never);
    expect(typeof dispose).toBe('function');

    // Queue a debounced persist, then dispose before the timer fires.
    listeners['resize']?.();
    dispose();

    for (const event of [
      'resize',
      'move',
      'maximize',
      'unmaximize',
      'enter-full-screen',
      'leave-full-screen',
      'close',
    ]) {
      expect(removeListener).toHaveBeenCalledWith(event, expect.any(Function));
    }

    // The pending debounce must not fire after disposal.
    vi.advanceTimersByTime(500);
    expect(set).not.toHaveBeenCalled();
  });

  it('does not capture state from a window destroyed before the debounce fires', () => {
    vi.useFakeTimers();

    const listeners: Record<string, () => void> = {};
    const isDestroyed = vi.fn().mockReturnValue(false);
    const isFullScreen = vi.fn().mockReturnValue(false);
    const win = {
      getBounds: vi.fn().mockReturnValue({ height: 700, width: 900, x: 1, y: 2 }),
      getNormalBounds: vi.fn().mockReturnValue({ height: 700, width: 900, x: 1, y: 2 }),
      isDestroyed,
      isFullScreen,
      isMaximized: vi.fn().mockReturnValue(false),
      on: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
      removeListener: vi.fn(),
    } as unknown as BrowserWindow;

    const set = vi.fn();
    const store = { get: vi.fn(), set } as unknown as {
      get: () => unknown;
      set: (key: string, value: unknown) => void;
    };

    registerWindowStatePersistence(win, store as never);

    listeners['resize']?.();
    // The window is destroyed before the debounced persist runs.
    isDestroyed.mockReturnValue(true);
    vi.advanceTimersByTime(250);

    // Guarded: no state capture (win.isFullScreen would throw on a destroyed window).
    expect(isFullScreen).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
