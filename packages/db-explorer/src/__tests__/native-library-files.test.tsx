import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NativeLibraryFiles } from '../components/native-library-files';

const file = {
  chunksCount: 1,
  chunksProcessed: true,
  content: null,
  contentHash: 'recorded-hash',
  createdAt: '2026-10-13T20:00:00.000Z',
  embeddingSetId: 'collection',
  fileId: 'recorded',
  fileName: 'recorded.txt',
  path: 'recorded.txt',
  rootId: null,
  stat: { mtimeMs: null, size: 14 },
  updatedAt: '2026-10-13T20:00:00.000Z',
};
afterEach(cleanup);
test('native Library lists canonical files and previews exact retained bytes without a DB provider', async () => {
  const read = vi
    .fn<SourceFilesCapability['read']>()
    .mockResolvedValue([{ ...file, content: 'retained bytes' }]);
  render(
    <NativeLibraryFiles
      collectionId="collection"
      files={{
        chunks: async () => ({ kind: 'unavailable', reason: 'Inactive collection' }),
        delete: vi.fn(),
        list: async () => [file],
        read,
      }}
      revision={0}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'recorded.txt' }));
  expect(await screen.findByText('retained bytes')).toBeTruthy();
  expect(await screen.findByText('Inactive collection')).toBeTruthy();
});
test('physical delete failure remains visible and does not remove the file from the list', async () => {
  const deletion = Promise.withResolvers<void>();
  render(
    <NativeLibraryFiles
      collectionId="collection"
      files={{
        chunks: vi.fn(),
        delete: () => deletion.promise,
        list: async () => [file],
        read: vi.fn(),
      }}
      revision={0}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Delete recorded.txt' }));
  deletion.reject(new Error('Physical retirement failed'));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Physical retirement failed'
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'recorded.txt' })).toBeTruthy());
});
