// @vitest-environment node
import { beforeEach, expect, it } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import type { NativeCanonicalCatalogRecord } from '../native-canonical-catalog';
import {
  emptyCollection,
  fixture,
  mocks,
  resetActivationFixture,
  setCatalogRecords,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

function row(
  fileId: string,
  rootId: string | null,
  relativePath: string | null
): NativeCanonicalCatalogRecord {
  return {
    chunksProcessed: true,
    content: null,
    contentHash: 'c'.repeat(64),
    embeddingSetId: 'selected',
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
  const records = [row('retained-0', null, null), row('kept-0', 'disconnected', 'kept.txt')];
  setCatalogRecords(() => records);
  let inventory: readonly { readonly fileId: string }[] = [];
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      const host = emptyCollection(dependencies);
      return {
        ...host,
        scan: async (requestId: string) => {
          inventory = await dependencies.source.inventory.loadFiles(dependencies.scope, {
            requestId,
            signal: new AbortController().signal,
          });
          return host.scan(requestId);
        },
      };
    }
  );
  const { activation } = fixture();
  await activation.acquire();
  expect(inventory.map((file) => file.fileId)).toEqual(['retained-0']);
  await activation.close();
});
