import type { BrowserWindow } from 'electron';
import type ElectronStore from 'electron-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopSettingsStoreSchema,
  DesktopWindowBounds,
  DesktopWindowState,
} from '../store-schema';
import {
  captureWindowState,
  getDefaultWindowState,
  persistWindowState,
  readStoredWindowState,
  registerWindowStatePersistence,
  resolveInitialWindowState,
} from '../window-state';

type WindowHandlers = Map<string, (...args: unknown[]) => void>;

interface MockBrowserWindow {
  getBounds: () => DesktopWindowBounds;
  getNormalBounds: () => DesktopWindowBounds;
  isDestroyed: () => boolean;
  isFullScreen: () => boolean;
  isMaximized: () => boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
}

const createMockStore = () => {
  const get = vi.fn();
  const set = vi.fn();
  const store = {
    get,
    set,
  } as unknown as ElectronStore<DesktopSettingsStoreSchema>;
  return { store, get, set };
};

const createMockWindow = (options: {
  fullScreen: boolean;
  maximized: boolean;
  bounds?: DesktopWindowBounds;
  normalBounds?: DesktopWindowBounds;
  handlers?: WindowHandlers;
}) => {
  const handlers = options.handlers ?? new Map<string, (...args: unknown[]) => void>();
  const bounds: DesktopWindowBounds =
    options.bounds ?? ({ width: 900, height: 700, x: 10.2, y: 20.8 } satisfies DesktopWindowBounds);
  const normalBounds: DesktopWindowBounds =
    options.normalBounds ??
    ({ width: 1200, height: 800, x: 15.6, y: 25.4 } satisfies DesktopWindowBounds);

  const win: MockBrowserWindow = {
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => options.fullScreen),
    isMaximized: vi.fn(() => options.maximized),
    getBounds: vi.fn(() => bounds),
    getNormalBounds: vi.fn(() => normalBounds),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    removeListener: vi.fn((event) => {
      handlers.delete(event);
    }),
  };

  return {
    win: win as unknown as BrowserWindow,
    handlers,
    spies: win,
  };
};

describe('window state helpers', () => {
  it('returns default window state when no stored state is provided', () => {
    const state = resolveInitialWindowState(null);

    expect(state).toEqual({
      bounds: { width: 1536, height: 800 },
      isFullScreen: false,
      isMaximized: true,
    });
  });

  it('returns stored window state when provided', () => {
    const stored: DesktopWindowState = {
      bounds: { width: 1024, height: 768 },
      isFullScreen: false,
      isMaximized: false,
    };

    expect(resolveInitialWindowState(stored)).toBe(stored);
  });

  it('reads and normalizes persisted window state', () => {
    const { store, get } = createMockStore();
    get.mockReturnValue({
      v1: {
        bounds: { width: 400.2, height: 500.9, x: 10.2, y: 20.8 },
        isFullScreen: true,
        isMaximized: true,
      },
    });

    const state = readStoredWindowState(store);

    expect(state).toEqual({
      bounds: { width: 800, height: 600, x: 10, y: 21 },
      isFullScreen: true,
      isMaximized: false,
    });
  });

  it('coerces invalid persisted values to safe defaults', () => {
    const { store, get } = createMockStore();
    get.mockReturnValue({
      v1: {
        bounds: { width: Number.NaN, height: 'tall', x: 1.4 },
        isFullScreen: 'nope',
        isMaximized: 'yep',
      },
    });

    const state = readStoredWindowState(store);

    expect(state).toEqual({
      bounds: { width: 1536, height: 800, x: 1 },
      isFullScreen: false,
      isMaximized: false,
    });
  });

  it('returns null when persisted window state is invalid or unreadable', () => {
    const { store, get } = createMockStore();
    get.mockReturnValue({ v1: 'invalid' });
    expect(readStoredWindowState(store)).toBeNull();

    get.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(readStoredWindowState(store)).toBeNull();
  });

  it('captures fullscreen window state using normal bounds', () => {
    const { win, spies } = createMockWindow({
      fullScreen: true,
      maximized: true,
      normalBounds: { width: 1001.4, height: 700.6, x: 5.5, y: 6.1 },
    });

    const state = captureWindowState(win);

    expect(spies.getNormalBounds).toHaveBeenCalled();
    expect(spies.getBounds).not.toHaveBeenCalled();
    expect(state).toEqual({
      bounds: { width: 1001, height: 701, x: 6, y: 6 },
      isFullScreen: true,
      isMaximized: false,
    });
  });

  it('captures maximized window state using normal bounds', () => {
    const { win, spies } = createMockWindow({
      fullScreen: false,
      maximized: true,
      normalBounds: { width: 1100, height: 650, x: 12.2, y: 19.7 },
    });

    const state = captureWindowState(win);

    expect(spies.getNormalBounds).toHaveBeenCalled();
    expect(spies.getBounds).not.toHaveBeenCalled();
    expect(state).toEqual({
      bounds: { width: 1100, height: 650, x: 12, y: 20 },
      isFullScreen: false,
      isMaximized: true,
    });
  });

  it('captures normal window state using current bounds', () => {
    const { win, spies } = createMockWindow({
      fullScreen: false,
      maximized: false,
      bounds: { width: 500, height: 500 },
    });

    const state = captureWindowState(win);

    expect(spies.getBounds).toHaveBeenCalled();
    expect(spies.getNormalBounds).not.toHaveBeenCalled();
    expect(state).toEqual({
      bounds: { width: 800, height: 600 },
      isFullScreen: false,
      isMaximized: false,
    });
  });

  it('persists window state to the store and ignores failures', () => {
    const { store, set } = createMockStore();
    const state = getDefaultWindowState();

    persistWindowState(store, state);

    expect(set).toHaveBeenCalledWith('windowState', { v1: state });

    set.mockImplementation(() => {
      throw new Error('write failed');
    });

    expect(() => persistWindowState(store, state)).not.toThrow();
  });

  describe('registerWindowStatePersistence', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces persistence and flushes on close', () => {
      const handlers: WindowHandlers = new Map();
      const { store, set } = createMockStore();
      const { win, spies } = createMockWindow({
        fullScreen: false,
        maximized: false,
        bounds: { width: 900, height: 700, x: 10, y: 20 },
        handlers,
      });

      registerWindowStatePersistence(win, store);

      expect(spies.on).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(spies.on).toHaveBeenCalledWith('move', expect.any(Function));
      expect(spies.on).toHaveBeenCalledWith('maximize', expect.any(Function));
      expect(spies.on).toHaveBeenCalledWith('unmaximize', expect.any(Function));
      expect(spies.on).toHaveBeenCalledWith('enter-full-screen', expect.any(Function));
      expect(spies.on).toHaveBeenCalledWith('leave-full-screen', expect.any(Function));
      expect(spies.on).toHaveBeenCalledWith('close', expect.any(Function));

      const close = handlers.get('close');
      const resize = handlers.get('resize');
      const move = handlers.get('move');

      close?.();
      expect(set).toHaveBeenCalledTimes(1);

      resize?.();
      move?.();
      vi.advanceTimersByTime(199);
      expect(set).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(set).toHaveBeenCalledTimes(2);

      resize?.();
      close?.();
      expect(set).toHaveBeenCalledTimes(3);

      vi.runAllTimers();
      expect(set).toHaveBeenCalledTimes(3);
      expect(set).toHaveBeenCalledWith('windowState', {
        v1: {
          bounds: { width: 900, height: 700, x: 10, y: 20 },
          isFullScreen: false,
          isMaximized: false,
        },
      });
    });
  });
});
