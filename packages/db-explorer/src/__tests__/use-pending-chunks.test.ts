import type { useBrainstrikeDbClient } from '@brainstrike/db';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePendingChunks } from '../use-pending-chunks';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePendingChunks', () => {
  it('filters chunk ids by active embedding set', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ dedupeKey: 'chunk-1:set-a:hash' }, { dedupeKey: 'chunk-2:set-b:hash' }],
    });
    const database = { query } as unknown as ReturnType<typeof useBrainstrikeDbClient>;
    const { result } = renderHook(() =>
      usePendingChunks({
        database,
        resolveActiveSetId: () => 'set-a',
        intervalMs: 0,
      })
    );

    await waitFor(() => {
      expect(Array.from(result.current.pendingChunkIds)).toEqual(['chunk-1']);
    });

    expect(query).toHaveBeenCalled();
  });

  it('clears pending chunk ids when no active set is available', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = { query } as unknown as ReturnType<typeof useBrainstrikeDbClient>;

    const { result, rerender } = renderHook(
      ({ resolver }: { resolver: () => string | null }) =>
        usePendingChunks({ database, resolveActiveSetId: resolver, intervalMs: 0 }),
      {
        initialProps: { resolver: (): string | null => 'set-a' },
      }
    );

    await act(async () => {
      await result.current.refreshPendingChunks();
    });

    expect(result.current.pendingChunkIds.size).toBe(0);

    rerender({ resolver: (): string | null => null });

    await act(async () => {
      await result.current.refreshPendingChunks();
    });

    expect(result.current.pendingChunkIds.size).toBe(0);
  });

  it('schedules polling when interval is provided', () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = { query } as unknown as ReturnType<typeof useBrainstrikeDbClient>;
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');

    const { unmount } = renderHook(() =>
      usePendingChunks({
        database,
        resolveActiveSetId: () => 'set-a',
        intervalMs: 25,
      })
    );

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(25);

    unmount();

    expect(clearSpy).toHaveBeenCalled();
  });
});
