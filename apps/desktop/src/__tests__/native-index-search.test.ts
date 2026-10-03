// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createNativeIndexSearchCapability } from '../native-index-search';

it('refuses a disconnected root before acquiring either native owner', async () => {
  const acquireIndexer = vi.fn(async () => {
    throw new Error('Writer must not be acquired');
  });
  const openQuery = vi.fn(async () => {
    throw new Error('Reader must not be acquired');
  });
  const capability = createNativeIndexSearchCapability({
    acquireIndexer,
    getAuthorizedRootIds: async () => ['live-root'],
    getRootReadiness: async () => [],
    openQuery,
  });
  await expect(
    capability.grep({
      caseSensitive: false,
      isRegex: false,
      limit: 10,
      pattern: 'alpha',
      rootIds: ['disconnected-root'],
    })
  ).rejects.toThrow('not currently authorized');
  expect(acquireIndexer).not.toHaveBeenCalled();
  expect(openQuery).not.toHaveBeenCalled();
});

it('preserves the operation and retained-reader cleanup causes together', async () => {
  const operation = new Error('reader failed');
  const cleanup = new Error('owned process did not exit');
  const capability = createNativeIndexSearchCapability({
    acquireIndexer: async () => {
      throw new Error('No writer read after failed grep');
    },
    getAuthorizedRootIds: async () => ['live-root'],
    getRootReadiness: async () => [],
    openQuery: async () => ({
      close: async () => {
        throw cleanup;
      },
      grep: async () => {
        throw operation;
      },
    }),
  });
  const result = await capability
    .grep({
      caseSensitive: false,
      isRegex: false,
      limit: 10,
      pattern: 'alpha',
      rootIds: ['live-root'],
    })
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  if (!(result instanceof AggregateError)) {
    throw new Error('Expected both cleanup causes');
  }
  expect(result.cause).toBe(operation);
  expect(result.errors).toEqual([operation, cleanup]);
});

it('refuses a reader snapshot from a different authoritative store', async () => {
  const close = vi.fn(async () => undefined);
  const capability = createNativeIndexSearchCapability({
    acquireIndexer: async () => ({
      coverage: async () => {
        throw new Error('Coverage is not part of this request');
      },
      info: async () => ({
        dbPath: '/index.sqlite',
        embedding: { indexMode: 'text-only' },
        journalMode: 'wal',
        pid: 1,
        readerQueryOnly: 1,
        storeId: 'b'.repeat(64),
        vecVersion: '0.1.9',
        writerThreadId: 1,
      }),
      search: async () => {
        throw new Error('Writer search is not part of grep');
      },
    }),
    getAuthorizedRootIds: async () => ['live-root'],
    getRootReadiness: async () => [],
    openQuery: async () => ({
      close,
      grep: async () => ({
        columns: [
          'id',
          'root_id',
          'file_record_id',
          'path',
          'content',
          'content_hash',
          'start_line',
          'end_line',
          'chunk_index',
          'chunk_size',
          'chunk_type',
          'start_offset',
          'end_offset',
          'token_count',
        ],
        identity: { embedding: { indexMode: 'text-only' }, storeId: 'a'.repeat(64) },
        matchedChunks: 1,
        rows: [
          [
            'c'.repeat(64),
            'live-root',
            'file',
            'a.ts',
            'alpha',
            'd'.repeat(64),
            1,
            1,
            0,
            5,
            'text',
            0,
            5,
            1,
          ],
        ],
        truncated: false,
      }),
    }),
  });
  await expect(
    capability.grep({
      caseSensitive: false,
      isRegex: false,
      limit: 10,
      pattern: 'alpha',
      rootIds: ['live-root'],
    })
  ).rejects.toThrow('identity changed');
  expect(close).toHaveBeenCalledOnce();
});
