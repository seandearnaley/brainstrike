import { afterEach, describe, expect, it, vi } from 'vitest';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), error: logError, info: vi.fn(), warn: vi.fn() }),
}));

import { canClaimWindowChords } from '../window-chord-capability';

/** `Reflect` because the window typings already declare a narrower `desktopLifecycle`. */
function setLifecycleBridge(bridge: unknown): void {
  Reflect.set(window, 'desktopLifecycle', bridge);
}

afterEach(() => {
  Reflect.deleteProperty(window, 'desktopLifecycle');
  logError.mockClear();
});

describe('canClaimWindowChords', () => {
  it('is false on web, where the browser owns ⌘W, ⌘T and Ctrl+Tab', () => {
    expect(canClaimWindowChords()).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  });

  it('is true when the desktop window-lifecycle bridge is present', () => {
    setLifecycleBridge({
      isTestMode: false,
      noteReloadIntent: () => Promise.resolve(),
    });
    expect(canClaimWindowChords()).toBe(true);
  });

  it('treats a malformed bridge as absent and says so', () => {
    setLifecycleBridge({ isTestMode: false });
    expect(canClaimWindowChords()).toBe(false);
    expect(logError).toHaveBeenCalledOnce();
  });
});
