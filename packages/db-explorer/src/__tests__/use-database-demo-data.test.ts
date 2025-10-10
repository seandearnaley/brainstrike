import type {
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
} from '@brainstrike/db';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDatabaseDemoData } from '../use-database-demo-data';

const createRepository = (
  records: FileRecord[] = [],
  count = records.length
): FileRecordRepository => {
  return {
    findAll: vi.fn().mockResolvedValue(records),
    count: vi.fn().mockResolvedValue(count),
  } as unknown as FileRecordRepository;
};

const createChunkRepository = (chunks: FileChunk[]): FileChunkRepository => {
  return {
    findAll: vi.fn().mockResolvedValue(chunks),
  } as unknown as FileChunkRepository;
};

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('useDatabaseDemoData', () => {
  it('loads records, chunks, and db info when repositories are provided', async () => {
    const repository = createRepository([
      {
        id: '1',
        name: 'file',
        path: '/file',
        size: 123,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as FileRecord,
    ]);
    const chunkRepository = createChunkRepository([
      {
        id: 'chunk-1',
        fileRecordId: '1',
        chunkIndex: 0,
        content: 'test',
        contentHash: 'hash',
        tokenCount: 10,
        chunkType: 'text',
        chunkSize: 10,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as FileChunk,
    ]);
    const toast = vi.fn();

    const { result } = renderHook(() =>
      useDatabaseDemoData({ repository, chunkRepository, toast })
    );

    await flushEffects();
    await flushEffects();

    expect(result.current.records).toHaveLength(1);
    expect(result.current.chunks).toHaveLength(1);
    expect(result.current.dbInfo?.connected).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('emits a toast when chunk loading fails with a non-vector error', async () => {
    const repository = createRepository();
    const chunkRepository = {
      findAll: vi.fn().mockRejectedValue(new Error('generic failure')),
    } as unknown as FileChunkRepository;
    const toast = vi.fn();

    const { result } = renderHook(() =>
      useDatabaseDemoData({ repository, chunkRepository, toast })
    );

    await flushEffects();
    await flushEffects();

    expect(result.current.chunks).toHaveLength(0);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]?.title).toBe('Error');
  });

  it('provides safe fallbacks when repositories are unavailable', async () => {
    const toast = vi.fn();

    const { result } = renderHook(() =>
      useDatabaseDemoData({ repository: null, chunkRepository: null, toast })
    );

    await flushEffects();

    expect(result.current.records).toEqual([]);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.dbInfo?.connected).toBe(false);
  });
});
