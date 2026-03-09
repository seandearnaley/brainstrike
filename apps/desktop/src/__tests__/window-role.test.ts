import { describe, expect, it } from 'vitest';
import { assignWindowRole, getWindowRole, getWindowRoleByWebContentsId } from '../window-role';

interface FakeWindow {
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
    onceCallCount: 0,
    once: (_event: 'closed', listener: () => void) => {
      window.onceCallCount += 1;
      closedListener = listener;
    },
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

    assignWindowRole(window as never, 'chunking-host');

    expect(getWindowRoleByWebContentsId(17)).toBe('chunking-host');
    expect(getWindowRole(window as never)).toBe('chunking-host');

    window.webContents = undefined as never;

    expect(() => emitClosed()).not.toThrow();
    expect(getWindowRoleByWebContentsId(17)).toBeUndefined();
  });

  it('does not register duplicate closed listeners when assigning the same window twice', () => {
    const { window } = createFakeWindow(23);

    assignWindowRole(window as never, 'chunking-host');
    assignWindowRole(window as never, 'embedding-host');

    expect(window.onceCallCount).toBe(1);
    expect(getWindowRoleByWebContentsId(23)).toBe('embedding-host');
  });
});
