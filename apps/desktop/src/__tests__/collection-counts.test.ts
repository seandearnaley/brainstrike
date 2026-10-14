import type { CollectionPort } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { readCollectionSnapshot } from '../collection-counts';

const collection = {
  createdAt: '2026-10-13T20:00:00.000Z',
  dimensions: 384,
  distance: 'cosine' as const,
  id: 'inactive',
  modelId: 'model',
  modelKey: 'local::model',
};
const store: CollectionPort = {
  collections: async () => ({
    collections: [collection],
    counts: [{ chunks: 3, files: 2, id: collection.id, unprocessedFiles: 1 }],
  }),
};
test('unavailable native owner preserves canonical counts without invented vector totals', async () => {
  const coverageBatch = vi.fn();
  const result = await readCollectionSnapshot(store, {
    coverageBatch,
    status: async () => ({
      kind: 'unavailable',
      phase: 'setup-required',
      reason: 'Choose a local embedding model',
    }),
  });
  expect(result).toEqual([
    {
      ...collection,
      counts: { chunks: 3, files: 2, unprocessedFiles: 1 },
      vectors: { kind: 'unavailable', reason: 'Choose a local embedding model' },
    },
  ]);
  expect(coverageBatch).not.toHaveBeenCalled();
});
test('unknown native failure propagates instead of becoming unavailable counts', async () => {
  const failure = new Error('Native database read failed');
  await expect(
    readCollectionSnapshot(store, {
      coverageBatch: vi.fn(),
      status: async () => {
        throw failure;
      },
    })
  ).rejects.toBe(failure);
});
