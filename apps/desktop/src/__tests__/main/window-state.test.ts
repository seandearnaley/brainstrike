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
      bounds: { width: 900, height: 700, x: 10, y: 20 },
      isFullScreen: false,
      isMaximized: false,
    };

    expect(resolveInitialWindowState(stored)).toEqual(stored);
    expect(resolveInitialWindowState(null)).toEqual(getDefaultWindowState());
  });

  it('clamps bounds when x/y are missing', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1000, height: 700 };
    getAllDisplays.mockReturnValue([{ workArea }]);

    const state = ensureWindowBoundsVisible({
      bounds: { width: 2000, height: 1200 },
      isFullScreen: false,
      isMaximized: false,
    });

    expect(state.bounds.width).toBe(1000);
    expect(state.bounds.height).toBe(700);
  });

  it('falls back to default bounds when off-screen', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 800, height: 600 };
    getAllDisplays.mockReturnValue([{ workArea }]);

    const state = ensureWindowBoundsVisible({
      bounds: { width: 900, height: 700, x: 5000, y: 5000 },
      isFullScreen: false,
      isMaximized: false,
    });

    expect(state.bounds.width).toBe(800);
    expect(state.bounds.height).toBe(600);
  });

  it('clamps bounds within a visible display', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1000, height: 800 };
    getAllDisplays.mockReturnValue([{ workArea }]);

    const state = ensureWindowBoundsVisible({
      bounds: { width: 500, height: 400, x: 900, y: 700 },
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
          bounds: { width: 200, height: 200, x: 1, y: 2 },
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
      isFullScreen: vi.fn().mockReturnValue(false),
      isMaximized: vi.fn().mockReturnValue(true),
      getNormalBounds: vi.fn().mockReturnValue({ x: 5, y: 6, width: 1200, height: 800 }),
      getBounds: vi.fn().mockReturnValue({ x: 1, y: 2, width: 600, height: 400 }),
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
      isFullScreen: vi.fn().mockReturnValue(false),
      isMaximized: vi.fn().mockReturnValue(false),
      getBounds: vi.fn().mockReturnValue({ x: 1, y: 2, width: 900, height: 700 }),
      getNormalBounds: vi.fn().mockReturnValue({ x: 1, y: 2, width: 900, height: 700 }),
      on: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb;
      }),
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
});
