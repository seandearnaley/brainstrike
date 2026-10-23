/**
 * Timestamp canonicalization for the shared collection cache.
 *
 * Pure data-shape helpers, deliberately outside the component module: they are
 * consumed by the live query, the one-shot snapshot AND `useCollectionCacheSync`
 * in db-explorer, none of which want a React import in the dependency path.
 */

/**
 * Pins a timestamp column to a primitive.
 *
 * PGlite returns `timestamptz` as a `Date`, and every read builds its own
 * instances for the same instant. `areCollectionsEqual` compares these with
 * `!==`, so two structurally identical snapshots never compare equal: a single
 * owner then rewrites the shared cache on every refresh, and a second live
 * `useCollections` — which the hook forbids, but only in a doc comment —
 * ping-pongs it into React #185. Normalizing removes the landmine instead of
 * leaving the invariant as the only thing standing between us and it.
 *
 * Strings pass through untouched, so no already-normalized value is rewritten.
 */
export function normalizeTimestamp(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

/** Anything starting `YYYY-MM-DDT` is already canonical and is left alone. */
const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T/u;

/**
 * Coerces a timestamp of UNKNOWN provenance to the same ISO form the query path
 * produces.
 *
 * The collections query is not the only way rows reach the shared cache: the
 * `embedding-set-updated` event carries an `EmbeddingSet`, whose `createdAt` is
 * TYPED `string` but is produced by `String(row.created_at)` in
 * `EmbeddingSetsRepository.fromRow` — and `String(new Date(…))` is
 * `'Sun Aug 09 2026 …'`, not ISO.
 *
 * Mixing the two formats in one cache breaks `compareCollectionsDesc`, which
 * compares `createdAt` relationally: `'S' > '2'`, so an event-sourced entry
 * would sort above every query-sourced one regardless of date. (Before
 * timestamps were normalized at all this hid behind a mixed Date/string compare
 * that yielded NaN and fell through to the id tiebreak.)
 *
 * Already-ISO strings pass through untouched so a round trip cannot drop
 * sub-millisecond precision, and an unparseable value is returned as-is rather
 * than replaced with an invented one.
 */
export function toCanonicalTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (ISO_TIMESTAMP_PREFIX.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * Normalizes an event-sourced collection so it can share a cache — and a
 * sort — with the query-sourced ones.
 *
 * Structural rather than tied to `CollectionWithDocCount` so this module never
 * has to import from the component file it was extracted out of.
 */
export function canonicalizeCollectionTimestamps<
  T extends { createdAt: string; statsLastRefreshedAt?: string | null },
>(collection: T): T {
  const createdAt = toCanonicalTimestamp(collection.createdAt);
  const statsLastRefreshedAt = collection.statsLastRefreshedAt
    ? toCanonicalTimestamp(collection.statsLastRefreshedAt)
    : (collection.statsLastRefreshedAt ?? null);

  if (
    createdAt === collection.createdAt &&
    statsLastRefreshedAt === collection.statsLastRefreshedAt
  ) {
    return collection;
  }
  return { ...collection, createdAt, statsLastRefreshedAt };
}
