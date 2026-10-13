import type { CanonicalSourceScope } from '@brainstrike/canonical-ingestion';
import type { NativeCanonicalCatalogRecord } from './native-canonical-catalog';
import type { NativeScopeReadiness } from './native-canonical-publication';

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
