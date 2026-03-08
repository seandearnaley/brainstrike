import { describe, expect, it } from 'vitest';
import { assignWindowRole, getWindowRole, getWindowRoleByWebContentsId } from '../window-role';

interface FakeWindow {
  once: (event: 'closed', listener: () => void) => void;
  webContents: {
    id: number;
  };
}

function createFakeWindow(webContentsId: number): {
  emitClosed: () => void;
  window: FakeWindow;
} {
  let closedListener: (() => void) | null = null;
  return {
    emitClosed: () => {
      if (!closedListener) {
        throw new Error('closed listener was not registered');
      }
      closedListener();
    },
    window: {
      once: (_event: 'closed', listener: () => void) => {
        closedListener = listener;
      },
      webContents: {
        id: webContentsId,
      },
    },
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
});
