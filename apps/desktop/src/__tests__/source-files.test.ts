import { createHash } from 'node:crypto';
import type { SourceCatalogRecord } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { createDesktopSourceFiles } from '../source-files';

const content = 'Actual imported bytes';
const file: SourceCatalogRecord = {
  chunksCount: null,
  chunksProcessed: false,
  content: null,
  contentHash: createHash('sha256').update(content).digest('hex'),
  createdAt: '2026-10-13T20:00:00.000Z',
  embeddingSetId: null,
  fileId: 'one',
  fileName: 'one.txt',
  path: 'one.txt',
  rootId: null,
  stat: { mtimeMs: null, size: content.length },
  updatedAt: '2026-10-13T20:00:00.000Z',
};
test('Library import preserves writer-owned duplicate receipts and hashes actual supplied bytes', async () => {
  const sourceCatalog = vi.fn(async () => ({ files: [file, file], imported: [true, false] }));
  const capability = createDesktopSourceFiles({
    catalog: { sourceCatalog },
    publishSources: async () => ({ kind: 'pending', reason: 'Inactive collection' }),
    readChunks: async () => ({ kind: 'unavailable', reason: 'Not configured' }),
    removeSources: vi.fn(),
  });
  const input = { content, name: file.fileName, path: file.path, size: content.length };
  expect(await capability.import({ embeddingSetId: null, files: [input, input] })).toEqual({
    indexing: { kind: 'pending', reason: 'Inactive collection' },
    items: [
      { file, imported: true },
      { file, imported: false },
    ],
  });
  expect(sourceCatalog).toHaveBeenCalledWith({
    embeddingSetId: null,
    files: [
      {
        content,
        contentHash: file.contentHash,
        fileName: file.fileName,
        path: file.path,
        stat: file.stat,
      },
      {
        content,
        contentHash: file.contentHash,
        fileName: file.fileName,
        path: file.path,
        stat: file.stat,
      },
    ],
    operation: 'import',
  });
});
test('Library delete retains captured canonical facts and joins physical cleanup failure', async () => {
  const pending = Promise.withResolvers<void>();
  const removeSources = vi.fn(() => pending.promise);
  const capability = createDesktopSourceFiles({
    catalog: { sourceCatalog: vi.fn(async () => ({ files: [file] })) },
    publishSources: async () => ({ kind: 'pending', reason: 'Inactive collection' }),
    readChunks: async () => ({ kind: 'unavailable', reason: 'Not configured' }),
    removeSources,
  });
  let resolved = false;
  const deletion = capability.delete([file.fileId]).then(() => {
    resolved = true;
  });
  await vi.waitFor(() => expect(removeSources).toHaveBeenCalledWith([file]));
  expect(resolved).toBe(false);
  const cause = new Error('Physical owner retained');
  pending.reject(cause);
  await expect(deletion).rejects.toBe(cause);
});
test('Library import refuses a response without atomic commit receipts', async () => {
  const capability = createDesktopSourceFiles({
    catalog: { sourceCatalog: vi.fn(async () => ({ files: [file] })) },
    publishSources: async () => ({ kind: 'pending', reason: 'Inactive collection' }),
    readChunks: async () => ({ kind: 'unavailable', reason: 'Not configured' }),
    removeSources: vi.fn(),
  });
  await expect(
    capability.import({
      embeddingSetId: null,
      files: [{ content, name: file.fileName, path: file.path, size: content.length }],
    })
  ).rejects.toThrow('commit receipts');
});
