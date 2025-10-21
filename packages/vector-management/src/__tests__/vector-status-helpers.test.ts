import { describe, expect, it, vi } from 'vitest';
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
    isWeb: false,
    workerLocalRunning: false,
    hasChunks: true,
    queueCounts: { running: 0 },
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
    const result = getBackfillDisabledState({ ...baseParams, queueCounts: { running: 1 } });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are currently running – wait for completion');
  });

  it('disables when jobs are running even with multiple jobs', () => {
    const result = getBackfillDisabledState({ ...baseParams, queueCounts: { running: 5 } });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are currently running – wait for completion');
  });

  it('disables on web when worker is not running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      isWeb: true,
      workerLocalRunning: false,
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Start worker to enable backfill on Web');
  });

  it('enables when all conditions are met and chunks are pending', () => {
    const result = getBackfillDisabledState(baseParams);
    expect(result.disabled).toBe(false);
    expect(result.title).toBe('Enqueue jobs for chunks missing embeddings for the active set');
  });

  it('enables when all conditions are met but no chunks pending', () => {
    const result = getBackfillDisabledState({ ...baseParams, hasChunks: false });
    expect(result.disabled).toBe(false);
    expect(result.title).toBe(
      'No pending chunks detected – you can still enqueue a backfill to double-check.'
    );
  });

  it('enables on web when worker is running and no jobs running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      isWeb: true,
      workerLocalRunning: true,
    });
    expect(result.disabled).toBe(false);
    expect(result.title).toBe('Enqueue jobs for chunks missing embeddings for the active set');
  });

  it('prioritizes checks in correct order: activeId before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      activeId: null,
      queueCounts: { running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Select an active embedding set');
  });

  it('prioritizes checks in correct order: hasDb before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      hasDb: false,
      queueCounts: { running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Database not ready yet');
  });

  it('prioritizes checks in correct order: backfilling before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      backfilling: true,
      queueCounts: { running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Backfilling in progress');
  });

  it('prioritizes running jobs check before web worker check', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      isWeb: true,
      workerLocalRunning: false,
      queueCounts: { running: 3 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are currently running – wait for completion');
  });
});
