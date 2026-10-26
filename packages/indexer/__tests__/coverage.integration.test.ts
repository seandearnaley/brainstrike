import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000 };
it('reports only actual authorized native text coverage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-index-coverage-'));
  const port = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: ['a', 'b'],
    },
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
      roots: [{ chunks: 2, indexedFiles: 1, rootId: 'a' }],
      storeId: (await port.info()).storeId,
      totals: { chunks: 2, indexedFiles: 1 },
    });
    expect((await port.coverage({ rootIds: ['a', 'b'] })).totals).toEqual({
      chunks: 2,
      indexedFiles: 1,
    });
    expect((await port.coverage({ rootIds: [] })).totals.chunks).toBe(0);
    await expect(port.coverage({ rootIds: ['foreign'] })).rejects.toThrow('not authorized');
    await expect(port.coverage({ rootIds: ['a', 'a'] })).rejects.toThrow();
    const many = await port.prepareFile({
      ...plan.snapshot,
      content: Array.from({ length: 101 }, () => 'needle source\n').join(''),
      fileId: 'many',
      relativePath: 'many.ts',
    });
    await port.commitTextFile({ plan: many });
    const lexical = await port.search({ limit: 3, mode: 'bm25', rootIds: ['a'], text: 'needle' });
    expect(lexical.hits).toHaveLength(3);
    expect(lexical).toMatchObject({
      candidateCount: 3,
      candidatesTruncated: true,
      scanLimited: false,
      truncated: true,
    });
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
