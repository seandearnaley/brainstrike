import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { embeddingProfileHash, openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { expect, it } from 'vitest';

const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
it('reports only actual authorized native coverage and never equates empty roots with vector readiness', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-index-coverage-'));
  const port = await openIndexer(
    { dbPath: path.join(directory, 'index.sqlite'), profile, rootIds: ['a', 'b'] },
    deadlines
  );
  try {
    const plan = await port.prepareFile({
      chunkLines: 1,
      content: 'first\nsecond\n',
      fileId: 'f',
      relativePath: 'f.ts',
      rootId: 'a',
    });
    await port.commitTextFile({ plan });
    const coverage = await port.coverage({ rootIds: ['a'] });
    expect(coverage).toEqual({
      profile,
      profileHash: embeddingProfileHash(profile),
      roots: [{ chunks: 2, indexedFiles: 1, missingVectors: 2, rootId: 'a', vectors: 0 }],
      totals: { chunks: 2, indexedFiles: 1, missingVectors: 2, vectors: 0 },
      vectorCoverageComplete: false,
    });
    const backfill = await port.prepareFile(plan.snapshot);
    await port.commitFile({
      embeddings: backfill.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan: backfill,
      profile,
    });
    expect((await port.coverage({ rootIds: ['a'] })).vectorCoverageComplete).toBe(true);
    expect((await port.coverage({ rootIds: ['a', 'b'] })).vectorCoverageComplete).toBe(false);
    expect((await port.coverage({ rootIds: [] })).totals.chunks).toBe(0);
    expect((await port.coverage({ rootIds: [] })).vectorCoverageComplete).toBe(false);
    await expect(port.coverage({ rootIds: ['foreign'] })).rejects.toThrow('not authorized');
    await expect(port.coverage({ rootIds: ['a', 'a'] })).rejects.toThrow();
    const many = await port.prepareFile({
      ...plan.snapshot,
      content: Array.from({ length: 101 }, () => 'needle source\n').join(''),
      fileId: 'many',
      relativePath: 'many.ts',
    });
    await port.commitFile({
      embeddings: many.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan: many,
      profile,
    });
    const lexical = await port.search({ limit: 3, mode: 'bm25', rootIds: ['a'], text: 'needle' });
    expect(lexical.hits).toHaveLength(3);
    expect(lexical).toMatchObject({
      candidateCount: 3,
      candidatesTruncated: true,
      scanLimited: false,
      truncated: true,
    });
    const semantic = await port.search({
      limit: 100,
      mode: 'vector',
      profile,
      rootIds: ['a'],
      vector,
    });
    expect(semantic.hits).toHaveLength(100);
    expect(semantic).toMatchObject({
      candidateCount: 100,
      candidatesTruncated: true,
      scanLimited: false,
      truncated: true,
    });
    const corrupt = openConnection((await port.info()).dbPath);
    try {
      const id = corrupt.prepare('SELECT pk FROM file_chunks LIMIT 1').pluck().get();
      if (typeof id !== 'number') {
        throw new TypeError('Expected actual chunk id.');
      }
      corrupt.prepare('DELETE FROM vec_chunks WHERE id=?').run(BigInt(id));
    } finally {
      corrupt.close();
    }
    await expect(port.coverage({ rootIds: ['a'] })).rejects.toThrow('presence disagrees');
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
