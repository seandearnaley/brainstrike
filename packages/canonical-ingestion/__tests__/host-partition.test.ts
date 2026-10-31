import { describe, expect, it, vi } from 'vitest';
import { discoveredFixture } from './host-test-fixture.js';

describe('canonical discovery partition membership', () => {
  // BST-1988: a workspace with no collection is the TEXT partition, and its
  // discoveries bind to that partition alone, never to a collection.
  it.each([
    { publishes: true, reply: null },
    { publishes: false, reply: 'managed-set' },
  ] as const)(
    'binds a TEXT-partition discovery only to a $reply reply when null',
    async ({ publishes, reply }) => {
      const f = await discoveredFixture(null);
      vi.mocked(f.catalog.prepareManagedSourcesBatch).mockResolvedValue([
        { ...f.file, contentHash: f.recorded.sourceHash, embeddingSetId: reply },
      ]);
      try {
        if (publishes) {
          await f.host.scan(f.request);
          expect(f.publication.commitTextFiles).toHaveBeenCalledWith(
            expect.objectContaining({
              files: [
                expect.objectContaining({
                  file: expect.objectContaining({ embeddingSetId: null }),
                }),
              ],
            })
          );
        } else {
          await expect(f.host.scan(f.request)).rejects.toThrow(/Canonical prepar/u);
          expect(f.publication.commitTextFiles).not.toHaveBeenCalled();
        }
      } finally {
        await f.host.close();
      }
    }
  );
});
