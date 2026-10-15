// @vitest-environment node
import type { SourceChunkPage, SourceFilesCapability } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import { readNativeFileChunks } from '../native-library-data';

const page: SourceChunkPage = {
  chunks: [
    {
      chunkId: 'one',
      chunkIndex: 0,
      chunkSize: 14,
      chunkType: 'text',
      content: 'recorded first',
      contentHash: 'first',
      endLine: 1,
      endOffset: 14,
      startLine: 1,
      startOffset: 0,
      tokenCount: 2,
      vector: null,
    },
  ],
  contentHash: 'source',
  fileId: 'file',
  kind: 'available',
  nextOffset: 1,
  profileHash: null,
  snapshotHash: 'snapshot',
  total: 2,
};
test('native Library export walks exact pages under one source and profile receipt', async () => {
  const chunks = vi
    .fn<SourceFilesCapability['chunks']>()
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce({
      ...page,
      chunks: [{ ...page.chunks[0]!, chunkId: 'two', chunkIndex: 1, content: 'recorded second' }],
      nextOffset: null,
    });
  expect(await readNativeFileChunks({ chunks }, 'file')).toEqual([
    ...page.chunks,
    { ...page.chunks[0]!, chunkId: 'two', chunkIndex: 1, content: 'recorded second' },
  ]);
  expect(chunks.mock.calls[1]?.[0]).toEqual({
    expected: { contentHash: 'source', profileHash: null, snapshotHash: 'snapshot' },
    fileId: 'file',
    limit: 100,
    offset: 1,
  });
});
test('inactive collection cannot become a successful empty export', async () => {
  await expect(
    readNativeFileChunks(
      { chunks: async () => ({ kind: 'unavailable', reason: 'Select collection' }) },
      'file'
    )
  ).rejects.toThrow('Select collection');
});
test('profile changes across pages cannot produce a mixed export', async () => {
  const chunks = vi
    .fn<SourceFilesCapability['chunks']>()
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce({ ...page, chunks: [], nextOffset: null, profileHash: 'other' });
  await expect(readNativeFileChunks({ chunks }, 'file')).rejects.toThrow('changed');
});
