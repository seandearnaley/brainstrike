/**
 * @vitest-environment happy-dom
 *
 * `collection_indexing_stats.last_refreshed_at` is a `timestamptz`, which PGlite
 * hands back as a `Date` even though `CollectionRow` declares `string | null`.
 * `areCollectionsEqual` compares that field with `!==`, so two structurally
 * identical reads built from separate `Date` instances never compare equal.
 *
 * Single-owner surfaces pay for this as needless `setCachedCollections` churn on
 * every refresh; a second live `useCollections` (which BST-1212 forbids, but only
 * in a doc comment) turns it into the store ping-pong that ends in React #185.
 * Pinning the value to a primitive at the boundary removes the landmine rather
 * than relying on the invariant holding forever.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteDatabase: () => null,
  usePGliteLiveQuery: () => ({ error: null, loading: false, refresh: vi.fn(), rows: [] }),
}));

import { fetchCollectionsSnapshot } from '../collection-select/collection-select';

const REFRESHED_AT_MS = Date.UTC(2026, 7, 9, 4, 5, 2, 535);
const CREATED_AT_MS = Date.UTC(2026, 4, 1, 0, 0, 0, 0);

/** A handle that returns fresh `Date` instances per call, like PGlite does. */
function dbReturningDates() {
  return {
    query: vi.fn().mockImplementation(() =>
      Promise.resolve({
        rows: [
          {
            category: null,
            chunkCount: '4',
            createdAt: new Date(CREATED_AT_MS),
            description: null,
            dimensions: 384,
            distance: 'cosine',
            embeddingCount: '4',
            fileCount: '2',
            id: 'alpha',
            modelId: 'model',
            modelKey: 'local::model',
            name: 'Collection alpha',
            statsAvailable: true,
            statsLastRefreshedAt: new Date(REFRESHED_AT_MS),
            systemRole: null,
            tags: null,
          },
        ],
      })
    ),
  };
}

describe('fetchCollectionsSnapshot timestamp normalization', () => {
  it('pins timestamp columns to primitives', async () => {
    const [collection] = await fetchCollectionsSnapshot(dbReturningDates() as never);

    expect(typeof collection?.statsLastRefreshedAt).toBe('string');
    expect(collection?.statsLastRefreshedAt).toBe(new Date(REFRESHED_AT_MS).toISOString());
    expect(typeof collection?.createdAt).toBe('string');
  });

  it('compares equal across two independent reads of the same row', async () => {
    const db = dbReturningDates();
    const [first] = await fetchCollectionsSnapshot(db as never);
    const [second] = await fetchCollectionsSnapshot(db as never);

    // Identity, not deep equality: this is exactly what `areCollectionsEqual`
    // does with `!==`, and it is what two `Date` instances fail.
    expect(first?.statsLastRefreshedAt).toBe(second?.statsLastRefreshedAt);
    expect(first?.createdAt).toBe(second?.createdAt);
  });

  it('leaves an absent refresh timestamp null rather than inventing one', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            category: null,
            chunkCount: 0,
            createdAt: '2026-05-01T00:00:00.000Z',
            description: null,
            dimensions: 384,
            distance: 'cosine',
            embeddingCount: 0,
            fileCount: 0,
            id: 'beta',
            modelId: 'model',
            modelKey: 'local::model',
            name: 'Collection beta',
            systemRole: null,
            tags: null,
          },
        ],
      }),
    };

    const [collection] = await fetchCollectionsSnapshot(db as never);

    expect(collection?.statsLastRefreshedAt).toBeNull();
    expect(collection?.createdAt).toBe('2026-05-01T00:00:00.000Z');
  });
});
