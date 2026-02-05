import type { LiveQueryResults } from '@electric-sql/pglite/live';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePGliteLiveQuery } from '../src/use-live-query.js';

vi.mock('../src/db-provider.js', () => ({
  usePGliteDatabase: () => null,
}));

interface UpdatePayload {
  id: number;
  results: LiveQueryResults<unknown>;
}

describe('usePGliteLiveQuery', () => {
  let updateCallback: ((payload: UpdatePayload) => void) | null = null;
  let start: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let refresh: ReturnType<typeof vi.fn>;
  let onUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateCallback = null;
    start = vi.fn().mockResolvedValue({
      id: 1,
      initialResults: { rows: [{ id: 1 }] } as LiveQueryResults<{ id: number }>,
    });
    stop = vi.fn().mockResolvedValue(undefined);
    refresh = vi.fn().mockResolvedValue(undefined);
    onUpdate = vi.fn((callback: (payload: UpdatePayload) => void) => {
      updateCallback = callback;
      return () => {
        updateCallback = null;
      };
    });

    (window as typeof window & { electronAPI?: unknown }).electronAPI = {
      dbLive: {
        start,
        stop,
        refresh,
        onUpdate,
      },
    };
  });

  afterEach(() => {
    (window as typeof window & { electronAPI?: unknown }).electronAPI = undefined;
  });

  it('does not resubscribe when select changes and uses the latest selector', async () => {
    const selectInitial = vi.fn((rows: Array<{ id: number }>) => rows);
    const selectUpdated = vi.fn((rows: Array<{ id: number }>) => rows);

    const { rerender } = renderHook(
      ({ select }) =>
        usePGliteLiveQuery({
          query: 'select * from files',
          select,
        }),
      {
        initialProps: { select: selectInitial },
      }
    );

    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(selectInitial).toHaveBeenCalled();
    });

    rerender({ select: selectUpdated });

    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });

    act(() => {
      updateCallback?.({
        id: 1,
        results: { rows: [{ id: 2 }] } as LiveQueryResults<{ id: number }>,
      });
    });

    await waitFor(() => {
      expect(selectUpdated).toHaveBeenCalled();
    });
  });
});
