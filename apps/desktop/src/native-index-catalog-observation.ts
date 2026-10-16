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

export function triggerCatalogWorkspaces(
  rootIds: readonly string[],
  triggers: ReadonlyMap<string, () => Promise<void>> | undefined,
  onError: (error: unknown) => void
): void {
  for (const rootId of rootIds) {
    triggers?.get(rootId)?.().catch(onError);
  }
}

interface CatalogObservation {
  readonly leases: ReadonlyMap<string, unknown>;
  observedCatalogFingerprint?: string;
  observedCatalogRecords?: readonly NativeCanonicalCatalogRecord[];
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
  if (current.queuedCatalogRefresh) {
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

export function catalogReadiness(current: CatalogObservation): readonly NativeScopeReadiness[] {
  const queued = current.queuedCatalogRecords;
  const observed = current.observedCatalogRecords ?? [];
  return (current.publication?.getReadiness() ?? []).map((readiness) => {
    const scope = readiness.scope;
    if (!queued) {
      return readiness;
    }
    const changed =
      scope.kind === 'collection' ||
      catalogFingerprint(observed.filter((record) => record.rootId === scope.rootId)) !==
        catalogFingerprint(queued.filter((record) => record.rootId === scope.rootId));
    return changed ? { ...readiness, scanComplete: false } : readiness;
  });
}

/** Record invalidation admission, independently of the publication owner's complete proof. */
export function observeNativeIndexCatalog(
  current: CatalogObservation,
  records: readonly NativeCanonicalCatalogRecord[]
): readonly string[] | undefined {
  const fingerprint = catalogFingerprint(records);
  if (current.observedCatalogFingerprint === fingerprint) {
    current.queuedCatalogRecords = undefined;
    return undefined;
  }
  const before = current.observedCatalogRecords ?? [];
  current.observedCatalogRecords = records;
  current.observedCatalogFingerprint = fingerprint;
  const collectionId = current.settings.managedCollectionId;
  if (collectionId !== null) {
    current.publication?.invalidateScope({ embeddingSetId: collectionId, kind: 'collection' });
  }
  const changedRoots = [...current.leases.keys()].filter(
    (rootId) =>
      catalogFingerprint(before.filter((record) => record.rootId === rootId)) !==
      catalogFingerprint(records.filter((record) => record.rootId === rootId))
  );
  for (const rootId of changedRoots) {
    current.publication?.invalidateScope({ kind: 'workspace', rootId });
  }
  current.queuedCatalogRecords = undefined;
  return changedRoots;
}
