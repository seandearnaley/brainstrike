import { afterEach, describe, expect, it } from 'vitest';
import { readThreadDebugHostProbe } from '../diagnostics/thread-debug-host-probe';

describe('readThreadDebugHostProbe', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopDiagnostics');
  });

  it('is null on web and on a preload that lacks either host reader', () => {
    expect(readThreadDebugHostProbe()).toBeNull();
    Object.assign(window, { desktopDiagnostics: { getSnapshot: () => Promise.resolve({}) } });
    expect(readThreadDebugHostProbe()).toBeNull();
    Object.assign(window, {
      desktopDiagnostics: {
        getSnapshot: () => Promise.resolve({}),
        readMainLogWindow: () => Promise.resolve({}),
      },
    });
    expect(readThreadDebugHostProbe()).toBeNull();
  });

  it('returns the bridge when both host readers exist', () => {
    const bridge = {
      getSnapshot: () => Promise.resolve({}),
      readMainLogWindow: () => Promise.resolve({}),
      readProcessCounters: () => Promise.resolve({}),
    };
    Object.assign(window, { desktopDiagnostics: bridge });
    expect(readThreadDebugHostProbe()).toBe(bridge);
  });
});
