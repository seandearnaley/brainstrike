// @vitest-environment node

import type { NativeCanonicalCatalogRecord } from '@brainstrike/canonical-ingestion';
import { beforeEach, expect, it } from 'vitest';
import type { CanonicalRemoteWorkspaceDependencies } from '../canonical-utility-parent';
import {
  emptyWorkspace,
  fixture,
  mocks,
  mountedRoot,
  resetActivationFixture,
  setCatalogRecords,
  setCatalogRoot,
  workspace,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

function row(fileId: string, rootId: string, relativePath: string): NativeCanonicalCatalogRecord {
  return {
    chunksProcessed: true,
    content: null,
    contentHash: 'c'.repeat(64),
    embeddingSetId: null,
    fileId,
    fileName: `${fileId}.txt`,
    path: relativePath,
    rootId,
    stat: { mtimeMs: 1, size: 1 },
  };
}

it('keeps a disconnected folder’s retained rows outside the authority instead of blocking every folder', async () => {
  // A folder disconnected with its indexed data kept leaves its rows, under its
  // one id, in the catalog for its return (BST-1990). It holds no lease, so no
  // mounted relative-path authority: the index covers only folders it leases.
  const records = [row('live-0', 'root', 'live.txt'), row('kept-0', 'disconnected', 'kept.txt')];
  setCatalogRecords(() => records);
  setCatalogRoot();
  let inventory: readonly { readonly fileId: string }[] = [];
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
      inventory = await dependencies.source.inventory.loadFiles(workspace, {
        requestId: 'inventory',
        signal: new AbortController().signal,
      });
      return emptyWorkspace(dependencies);
    }
  );
  const { activation } = fixture(mountedRoot());
  await activation.acquire();
  expect(mocks.acquire.mock.calls[0]?.[0]).toMatchObject({
    fileBindings: [expect.objectContaining({ fileId: 'live-0', rootId: 'root' })],
    rootIds: ['root'],
  });
  expect(inventory.map((file) => file.fileId)).toEqual(['live-0']);
  await activation.close();
});
