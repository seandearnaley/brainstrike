import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeTimeFromNow, mapEmbeddingSetRows } from '../vector-status';
import { getBackfillDisabledState } from '../vector-status/backfill-utils';
import {
  handleQueueStateChange,
  type VectorQueueDatabase,
  withTransaction,
} from '../vector-status/vector-queue-service';

describe('vector-status helpers', () => {
  it('withTransaction commits on success and rolls back on error', async () => {
    const calls: string[] = [];
    const db: VectorQueueDatabase = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
    };

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

describe('getBackfillDisabledState', () => {
  const baseParams = {
    activeId: 'set-1',
    hasDb: true,
    backfilling: false,
    coverage: { total: 148, withSet: 0 }, // 148 chunks, 0 embedded
    queueCounts: { queued: 0, running: 0 },
  };

  it('disables when no active embedding set selected', () => {
    const result = getBackfillDisabledState({ ...baseParams, activeId: null });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Select an active embedding set');
  });

  it('disables when database is not ready', () => {
    const result = getBackfillDisabledState({ ...baseParams, hasDb: false });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Database not ready yet');
  });

  it('disables when backfilling is already in progress', () => {
    const result = getBackfillDisabledState({ ...baseParams, backfilling: true });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Backfilling in progress');
  });

  it('disables when jobs are currently running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 0, running: 1 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when jobs are running even with multiple jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when jobs are queued but not yet running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 3, running: 0 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when jobs are both queued and running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 5, running: 2 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when all chunks already embedded', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      coverage: { total: 148, withSet: 148 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('All chunks already embedded for active set');
  });

  it('enables when all conditions are met and chunks are pending', () => {
    const result = getBackfillDisabledState(baseParams);
    expect(result.disabled).toBe(false);
    expect(result.title).toBe('Enqueue jobs for chunks missing embeddings for the active set');
  });

  it('enables when no chunks exist (empty database)', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      coverage: { total: 0, withSet: 0 },
    });
    expect(result.disabled).toBe(false);
    expect(result.title).toBe(
      'No pending chunks detected – you can still enqueue a backfill to double-check.'
    );
  });

  it('prioritizes checks in correct order: activeId before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      activeId: null,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Select an active embedding set');
  });

  it('prioritizes checks in correct order: hasDb before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      hasDb: false,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Database not ready yet');
  });

  it('prioritizes checks in correct order: backfilling before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      backfilling: true,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Backfilling in progress');
  });

  it('prioritizes running jobs before coverage complete check', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      coverage: { total: 148, withSet: 148 },
      queueCounts: { queued: 0, running: 3 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });
});

describe('formatRelativeTimeFromNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "never" when timestamp missing', () => {
    expect(formatRelativeTimeFromNow(null)).toBe('never');
  });

  it('returns "unknown" for invalid timestamp', () => {
    expect(formatRelativeTimeFromNow('not-a-date')).toBe('unknown');
  });

  it('describes minutes, hours, and days appropriately', () => {
    expect(formatRelativeTimeFromNow('2025-01-01T11:45:00.000Z')).toBe('15m ago');
    expect(formatRelativeTimeFromNow('2025-01-01T10:00:00.000Z')).toBe('2h ago');
    expect(formatRelativeTimeFromNow('2024-12-28T12:00:00.000Z')).toBe('4d ago');
  });
});

describe('mapEmbeddingSetRows', () => {
  it('includes zero-count sets when chunks exist elsewhere', () => {
    const rows = [
      {
        id: 'set-a',
        modelKey: 'local::jina-code',
        modelId: 'jina-code',
        dimensions: 768,
        distance: 'cosine',
        createdAt: '2025-01-01T00:00:00.000Z',
        chunkCount: 42,
        lastEmbeddedAt: '2025-01-01T01:00:00.000Z',
      },
      {
        id: 'set-b',
        modelKey: 'local::bge-m3',
        modelId: 'bge-m3',
        dimensions: 1024,
        distance: 'cosine',
        createdAt: '2025-01-01T00:00:00.000Z',
        chunkCount: 0,
        lastEmbeddedAt: null,
      },
    ];
    const mapped = mapEmbeddingSetRows(rows, true);
    expect(mapped).toHaveLength(2);
    expect(mapped[1]).toMatchObject({
      id: 'set-b',
      chunkCount: 0,
    });
  });

  it('hides zero-count sets when database has zero chunks', () => {
    const rows = [
      {
        id: 'seeded',
        modelKey: 'local::jina-code',
        modelId: 'jina-code',
        dimensions: 768,
        distance: 'cosine',
        createdAt: '2025-01-01T00:00:00.000Z',
        chunkCount: 0,
        lastEmbeddedAt: null,
      },
    ];
    const mapped = mapEmbeddingSetRows(rows, false);
    expect(mapped).toHaveLength(0);
  });
});
