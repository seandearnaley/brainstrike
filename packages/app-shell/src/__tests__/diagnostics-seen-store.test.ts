import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetDiagnosticsSeenStore,
  useDiagnosticsSeenStore,
} from '../diagnostics/diagnostics-seen-store';

describe('diagnostics-seen-store', () => {
  beforeEach(() => {
    resetDiagnosticsSeenStore();
  });

  it('seeds lastSeenAtMs to "now" at store creation', () => {
    const before = Date.now();
    // Module-level store was already created before this test ran; reset
    // re-seeds it the same way, so this pins that behavior directly.
    resetDiagnosticsSeenStore();
    const after = Date.now();

    const { lastSeenAtMs } = useDiagnosticsSeenStore.getState();
    expect(lastSeenAtMs).toBeGreaterThanOrEqual(before);
    expect(lastSeenAtMs).toBeLessThanOrEqual(after);
  });

  it('markAllSeen advances the watermark to the given timestamp', () => {
    const initial = useDiagnosticsSeenStore.getState().lastSeenAtMs;
    const advanced = initial + 60_000;

    useDiagnosticsSeenStore.getState().markAllSeen(advanced);

    expect(useDiagnosticsSeenStore.getState().lastSeenAtMs).toBe(advanced);
  });

  it('resetDiagnosticsSeenStore restores the initial "now" seed after markAllSeen moved it', () => {
    useDiagnosticsSeenStore.getState().markAllSeen(0);
    expect(useDiagnosticsSeenStore.getState().lastSeenAtMs).toBe(0);

    vi.useFakeTimers();
    try {
      const fixedNow = 1_700_000_000_000;
      vi.setSystemTime(fixedNow);

      resetDiagnosticsSeenStore();

      expect(useDiagnosticsSeenStore.getState().lastSeenAtMs).toBe(fixedNow);
    } finally {
      vi.useRealTimers();
    }
  });
});
