import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useDiagnosticsSeenStore } from '../diagnostics/diagnostics-seen-store';
import { useUnseenDiagnosticsCount } from '../diagnostics/use-unseen-diagnostics-count';

vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...args: unknown[]) => args.join(':'),
  usePGliteDatabase: ({ enabled }: { enabled?: boolean } = {}) => {
    if (enabled !== false) {
      throw new Error('Native diagnostics attempted PGlite');
    }
    return null;
  },
  usePGliteLiveQuery: ({ enabled }: { enabled?: boolean }) => {
    if (enabled) {
      throw new Error('Native diagnostics attempted SQL');
    }
    return { error: null, loading: false, rows: [] };
  },
}));

afterEach(() => {
  Reflect.deleteProperty(window, 'desktopDiagnostics');
  Reflect.deleteProperty(window, 'logging');
});

test('reads retained counts and refreshes on durable acknowledgment and mark-seen', async () => {
  let notify: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const read = vi.fn(async () => ({ errorCount: 2, warningCount: 3 }));
  Object.defineProperty(window, 'desktopDiagnostics', {
    configurable: true,
    value: { getUnseenCounts: read },
  });
  Object.defineProperty(window, 'logging', {
    configurable: true,
    value: {
      onDurableRecord: (listener: () => void) => {
        notify = listener;
        return unsubscribe;
      },
    },
  });
  useDiagnosticsSeenStore.setState({ lastSeenAtMs: 1000 });
  const { result, unmount } = renderHook(() => useUnseenDiagnosticsCount());
  await waitFor(() =>
    expect(result.current).toEqual({ error: null, errorCount: 2, warningCount: 3 })
  );
  expect(read).toHaveBeenLastCalledWith(1000);
  read.mockResolvedValue({ errorCount: 3, warningCount: 3 });
  act(() => notify?.());
  await waitFor(() => expect(result.current.errorCount).toBe(3));
  read.mockResolvedValue({ errorCount: 0, warningCount: 0 });
  act(() => useDiagnosticsSeenStore.getState().markAllSeen(2000));
  await waitFor(() => expect(result.current.errorCount).toBe(0));
  expect(read).toHaveBeenLastCalledWith(2000);
  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

test('surfaces retained-reader failure instead of silently reporting no diagnostics', async () => {
  const failure = new Error('Retained log unreadable');
  Object.defineProperty(window, 'desktopDiagnostics', {
    configurable: true,
    value: { getUnseenCounts: vi.fn().mockRejectedValue(failure) },
  });
  Object.defineProperty(window, 'logging', {
    configurable: true,
    value: { onDurableRecord: () => () => undefined },
  });
  const { result } = renderHook(() => useUnseenDiagnosticsCount());
  await waitFor(() => expect(result.current.error).toBe(failure));
});
