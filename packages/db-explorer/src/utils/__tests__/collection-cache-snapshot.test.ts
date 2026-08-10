import type { EmbeddingSet } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import { collectionCacheSnapshotFromEmbeddingSet } from '../collection-cache-snapshot';

function embeddingSet(createdAt: string): EmbeddingSet {
  return {
    createdAt,
    dimensions: 768,
    distance: 'cosine',
    id: 'set-1',
    modelId: 'model-1',
    modelKey: 'key-1',
    name: 'Docs',
  } as unknown as EmbeddingSet;
}

describe('collectionCacheSnapshotFromEmbeddingSet (PR #2381 review)', () => {
  /**
   * `EmbeddingSet.createdAt` is typed `string` but built by
   * `String(row.created_at)`, so a Date arrives as 'Sun Aug 09 2026 …'. Both
   * callers upsert AFTER the embedding-set-updated listener has written the
   * canonicalized entry, so a raw value here clobbers it — and
   * `compareCollectionsDesc` compares createdAt relationally ('S' > '2'),
   * sorting the clobbered entry above every ISO one regardless of date.
   */
  it('canonicalizes a non-ISO createdAt so it cannot out-sort ISO entries', () => {
    const snapshot = collectionCacheSnapshotFromEmbeddingSet(
      embeddingSet('Sun Aug 09 2026 12:00:00 GMT+0000')
    );

    expect(snapshot.createdAt).toBe(new Date('Sun Aug 09 2026 12:00:00 GMT+0000').toISOString());
    expect(snapshot.createdAt.startsWith('2026-')).toBe(true);
  });

  it('leaves an already-ISO createdAt byte-identical (no precision round trip)', () => {
    const iso = '2026-08-09T12:00:00.123Z';
    expect(collectionCacheSnapshotFromEmbeddingSet(embeddingSet(iso)).createdAt).toBe(iso);
  });

  it('sorts below a newer ISO entry rather than above it', () => {
    const older = collectionCacheSnapshotFromEmbeddingSet(
      embeddingSet('Sun Aug 09 2026 12:00:00 GMT+0000')
    );
    const newer = '2026-08-10T00:00:00.000Z';
    // Relational compare is what the real comparator does.
    expect(older.createdAt < newer).toBe(true);
  });
});
