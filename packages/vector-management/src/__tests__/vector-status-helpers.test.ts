import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

// Mock heavy modules before importing the module under test
vi.mock('@brainstrike/ui', () => ({}));
vi.mock('@brainstrike/embeddings', () => ({ TransformersBackend: { getBestDevice: () => 'cpu' } }));
vi.mock('@brainstrike/db', () => ({ usePGliteDatabase: () => null, useFactoryReset: () => null }));

import { handleQueueStateChange, withTransaction } from '../vector-status/vector-queue-service';

describe('vector-status helpers', () => {
  it('withTransaction commits on success and rolls back on error', async () => {
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
    } as Partial<PGlite> as PGlite;

    await withTransaction(db, async () => {
      calls.push('BODY');
    });
    expect(calls).toEqual(['BEGIN', 'BODY', 'COMMIT']);

    calls.length = 0;
    await expect(
      withTransaction(db, async () => {
        calls.push('BODY');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['BEGIN', 'BODY', 'ROLLBACK']);
  });

  it('handleQueueStateChange dispatches queue-drained event when transitioning to idle', () => {
    const busyRef = { current: true };
    const spy = vi.spyOn(window, 'dispatchEvent');
    handleQueueStateChange({ queued: 0, running: 0 }, busyRef, 'set-1');
    expect(spy).toHaveBeenCalledTimes(1);
    const evt = spy.mock.calls[0]?.[0] as CustomEvent;
    expect(evt.type).toBe('brainstrike:queue-drained');
    expect((evt.detail as { embeddingSetId: string }).embeddingSetId).toBe('set-1');
    expect(busyRef.current).toBe(false);
    spy.mockRestore();
  });
});
