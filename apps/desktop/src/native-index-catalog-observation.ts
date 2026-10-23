import type {
  CanonicalSourceScope,
  NativeCanonicalCatalogRecord,
  NativeScopeReadiness,
} from '@brainstrike/canonical-ingestion';

export function catalogFingerprint(records: readonly NativeCanonicalCatalogRecord[]): string {
  return JSON.stringify(
    records.map(({ chunksProcessed: _processed, content: _content, ...record }) => record)
  );
}

interface CatalogObservation {
  observedCatalogFingerprint?: string;
  readonly publication?: {
    invalidateScope(scope: CanonicalSourceScope): void;
    getReadiness(): readonly NativeScopeReadiness[];
  };
  queuedCatalogRecords?: readonly NativeCanonicalCatalogRecord[] | undefined;
  /** Null for the TEXT partition, which has workspace scopes and no collection scope. */
  readonly settings: { readonly managedCollectionId: string | null };
}

/** A read cannot replace bindings while the previous canonical scan still owns completion. */
export function deferNativeIndexCatalog(
  current: CatalogObservation,
  records: readonly NativeCanonicalCatalogRecord[],
  scan: Promise<void> | readonly Promise<void>[] | undefined
): Promise<void> | undefined {
  if (
    !scan ||
    (Array.isArray(scan) && scan.length === 0) ||
    (!current.queuedCatalogRecords &&
      current.observedCatalogFingerprint === catalogFingerprint(records))
  ) {
    return undefined;
  }
  current.queuedCatalogRecords = records;
  return Promise.all(Array.isArray(scan) ? scan : [scan]).then(() => {});
}

/**
 * Settles a catalog change a running scan deferred. Writer acquisition joins the
 * scan, then refreshes. A read answers from the committed catalog instead, and
 * one refresh per graph applies the queued change once the scan settles; until
 * then readiness reports it as incomplete (BST-2012).
 */
export async function settleDeferredNativeIndexCatalog(
  current: { queuedCatalogRefresh?: Promise<void> | undefined },
  settled: Promise<void>,
  join: boolean,
  refresh: () => Promise<void>,
  onRefreshFailure: (error: unknown) => void
): Promise<void> {
  if (join) {
    await settled;
    // A read's queued refresh applies the change first; this writer then refreshes after it.
    await current.queuedCatalogRefresh;
    await refresh();
    return;
  }
  if (current.queuedCatalogRefresh !== undefined) {
    // The queued refresh applies this change too. Observe this read's own join, which source
    // retirement rejects; the scan's own owner reports a failure.
    settled.catch(() => undefined);
    return;
  }
  current.queuedCatalogRefresh = settled
    // The scan's own owner reports its failure; the queue stays visibly incomplete.
    .then(refresh, () => undefined)
    .catch(onRefreshFailure)
    .finally(() => {
      current.queuedCatalogRefresh = undefined;
    });
}

/**
 * A workspace root's records have one writer, its own scan, so its readiness is the
 * publication's alone; a queued catalog change holds back only the collection.
 */
export function catalogReadiness(current: CatalogObservation): readonly NativeScopeReadiness[] {
  return (current.publication?.getReadiness() ?? []).map((readiness) =>
    current.queuedCatalogRecords && readiness.scope.kind === 'collection'
      ? { ...readiness, scanComplete: false }
      : readiness
  );
}

/** Whether the catalog changed since last observed; a change invalidates the collection only. */
export function observeNativeIndexCatalog(
  current: CatalogObservation,
  records: readonly NativeCanonicalCatalogRecord[]
): boolean {
  const fingerprint = catalogFingerprint(records);
  current.queuedCatalogRecords = undefined;
  if (current.observedCatalogFingerprint === fingerprint) {
    return false;
  }
  current.observedCatalogFingerprint = fingerprint;
  const collectionId = current.settings.managedCollectionId;
  if (collectionId !== null) {
    current.publication?.invalidateScope({ embeddingSetId: collectionId, kind: 'collection' });
  }
  return true;
}
