import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(cleanupDirs);
test('rootless imported bytes retain one identity per content and collection across reopen', async () => {
  const directory = freshDir('source-import');
  const indexer = new TruthIndexer(directory);
  let store = await StateStore.open(directory, { indexer });
  const content = 'Actual imported source';
  const source = {
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    fileName: 'import.txt',
    path: 'import.txt',
    stat: { mtimeMs: null, size: Buffer.byteLength(content) },
  };
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'rooted', path: '/disposable/rooted', preferredId: 'rooted' },
    });
    const managed = (
      await store.sourceCatalog({
        embeddingSetId: null,
        files: [source],
        operation: 'prepare',
        rootId: 'rooted',
      })
    ).files[0];
    const imported = await store.sourceCatalog({
      embeddingSetId: null,
      files: [source, source],
      operation: 'import',
    });
    const first = imported.files[0];
    expect(imported.imported).toEqual([true, false]);
    expect(first?.fileId).not.toBe(managed?.fileId);
    expect(first?.rootId).toBeNull();
    expect(first).toMatchObject({
      contentHash: source.contentHash,
      embeddingSetId: null,
      rootId: null,
    });
    if (!first) {
      throw new Error('Import omitted its committed ID');
    }
    expect(Number.isFinite(Date.parse(first.createdAt))).toBe(true);
    expect(first.updatedAt).toBe(first.createdAt);
    expect(first.chunksCount).toBeNull();
    const repeated = (
      await store.sourceCatalog({
        embeddingSetId: null,
        files: [{ ...source, path: 'same-content.txt' }],
        operation: 'import',
      })
    ).files[0];
    expect(repeated?.fileId).toBe(first.fileId);
    await store.close();
    store = await StateStore.open(directory, { indexer });
    expect(
      (
        await store.sourceCatalog({
          fileIds: [first.fileId],
          maxContentBytes: Buffer.byteLength(content),
          operation: 'read',
        })
      ).files[0]
    ).toEqual({ ...first, content });
    await expect(
      store.sourceCatalog({
        embeddingSetId: 'missing-collection',
        files: [source],
        operation: 'import',
      })
    ).rejects.toThrow();
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toEqual(expect.arrayContaining([first, managed]));
  } finally {
    await store.close();
    indexer.close();
  }
});
