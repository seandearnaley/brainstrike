import { afterEach, describe, expect, it } from 'vitest';
import { readThreadDebugHostProbe } from '../diagnostics/thread-debug-host-probe';

describe('readThreadDebugHostProbe', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopDiagnostics');
  });

  it('is null on web and on a preload that lacks any host reader', () => {
    expect(readThreadDebugHostProbe()).toBeNull();
    Object.assign(window, { desktopDiagnostics: { getSnapshot: () => Promise.resolve({}) } });
    expect(readThreadDebugHostProbe()).toBeNull();
    Object.assign(window, {
      desktopDiagnostics: {
        getSnapshot: () => Promise.resolve({}),
        readMainLogWindow: () => Promise.resolve({ ok: true, value: { lines: [] } }),
      },
    });
    expect(readThreadDebugHostProbe()).toBeNull();
    Object.assign(window, {
      desktopDiagnostics: {
        readMainLogWindow: () => Promise.resolve({ ok: true, value: { lines: [] } }),
        readProcessCounters: () => Promise.resolve({ ok: true, value: { samples: [] } }),
      },
    });
    expect(readThreadDebugHostProbe()).toBeNull();
  });

  it('decodes the log and counter readers after transport, and passes the retained events on', async () => {
    const events = [{ id: 'event-1', severity: 'error' }];
    const bridge = {
      getSnapshot: () => Promise.resolve({}),
      queryEvents: () => Promise.resolve(events),
      readMainLogWindow: () => Promise.resolve({ ok: true, value: { lines: [] } }),
      readProcessCounters: () => Promise.resolve({ ok: true, value: { samples: [] } }),
    };
    Object.assign(window, { desktopDiagnostics: bridge });
    const probe = readThreadDebugHostProbe();
    await expect(probe?.readMainLogWindow({ since: 'start', until: 'end' })).resolves.toEqual({
      lines: [],
    });
    await expect(probe?.readProcessCounters()).resolves.toEqual({ samples: [] });
    await expect(probe?.queryEvents({ limit: 50 })).resolves.toBe(events);
  });
});
