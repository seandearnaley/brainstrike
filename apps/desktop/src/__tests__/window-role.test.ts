import { describe, expect, it } from 'vitest';
import {
  assignWindowRole,
  clearWindowRoleByWebContentsId,
  getTrackedWindowsByRole,
  getWindowRole,
  getWindowRoleByWebContentsId,
  resolveSourceWindowRole,
  UNKNOWN_SOURCE_WINDOW_ROLE,
} from '../window-role';

interface FakeWindow {
  isDestroyed: () => boolean;
  once: (event: 'closed', listener: () => void) => void;
  onceCallCount: number;
  webContents: {
    id: number;
  };
}

function createFakeWindow(webContentsId: number): {
  emitClosed: () => void;
  window: FakeWindow;
} {
  let closedListener: (() => void) | null = null;
  const window: FakeWindow = {
    isDestroyed: () => false,
    once: (_event: 'closed', listener: () => void) => {
      window.onceCallCount += 1;
      closedListener = listener;
    },
    onceCallCount: 0,
    webContents: {
      id: webContentsId,
    },
  };
  return {
    emitClosed: () => {
      if (!closedListener) {
        throw new Error('closed listener was not registered');
      }
      closedListener();
    },
    window,
  };
}

describe('window-role', () => {
  it('removes the role mapping when a window closes after its webContents is destroyed', () => {
    const { emitClosed, window } = createFakeWindow(17);

    assignWindowRole(window as never, 'embedding-host');

    expect(getWindowRoleByWebContentsId(17)).toBe('embedding-host');
    expect(getWindowRole(window as never)).toBe('embedding-host');

    window.webContents = undefined as never;

    expect(() => emitClosed()).not.toThrow();
    expect(getWindowRoleByWebContentsId(17)).toBeUndefined();
  });

  it('does not register duplicate closed listeners when assigning the same window twice', () => {
    const { window } = createFakeWindow(23);

    assignWindowRole(window as never, 'visible-ui');
    assignWindowRole(window as never, 'embedding-host');

    expect(window.onceCallCount).toBe(1);
    expect(getWindowRoleByWebContentsId(23)).toBe('embedding-host');
  });

  it('supports explicit role cleanup by webContents id', () => {
    const { window } = createFakeWindow(29);

    assignWindowRole(window as never, 'visible-ui');
    clearWindowRoleByWebContentsId(29);

    expect(getWindowRoleByWebContentsId(29)).toBeUndefined();
  });

  it('tracks live windows by role and removes them when explicitly cleared', () => {
    const first = createFakeWindow(31);
    const second = createFakeWindow(32);

    assignWindowRole(first.window as never, 'visible-ui');
    assignWindowRole(second.window as never, 'visible-ui');

    expect(getTrackedWindowsByRole('visible-ui')).toEqual([
      first.window as never,
      second.window as never,
    ]);

    clearWindowRoleByWebContentsId(31);

    expect(getTrackedWindowsByRole('visible-ui')).toEqual([second.window as never]);
  });

  describe('resolveSourceWindowRole', () => {
    it('returns the tracked role for a known webContents id', () => {
      const { window } = createFakeWindow(41);
      assignWindowRole(window as never, 'embedding-host');

      expect(resolveSourceWindowRole(41)).toBe('embedding-host');

      clearWindowRoleByWebContentsId(41);
    });

    it('falls back to the shared unknown-role constant for an untracked webContents id', () => {
      expect(getWindowRoleByWebContentsId(99_999)).toBeUndefined();
      expect(resolveSourceWindowRole(99_999)).toBe(UNKNOWN_SOURCE_WINDOW_ROLE);
      expect(UNKNOWN_SOURCE_WINDOW_ROLE).toBe('hidden-host');
    });
  });
});
