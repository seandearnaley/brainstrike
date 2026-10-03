import type { CanonicalScanReceipt, CanonicalSourceScope } from '@brainstrike/canonical-ingestion';
import type { NativeCanonicalCatalogRecord } from './native-canonical-catalog';

export function catalogFingerprint(records: readonly NativeCanonicalCatalogRecord[]): string {
  return JSON.stringify(
    records.map(({ chunksProcessed: _processed, content: _content, ...record }) => record)
  );
}

export function isSupersededCatalogScan(
  receipt: CanonicalScanReceipt,
  observedFingerprint: string | undefined,
  scanned: readonly NativeCanonicalCatalogRecord[]
): boolean {
  return (
    receipt.reason === 'manifest-mismatch' &&
    observedFingerprint !== undefined &&
    observedFingerprint !== catalogFingerprint(scanned)
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
  readonly publication?: { invalidateScope(scope: CanonicalSourceScope): void };
  readonly settings: { readonly managedCollectionId: string };
}

/** Record invalidation admission, independently of the publication owner's complete proof. */
export function observeNativeIndexCatalog(
  current: CatalogObservation,
  records: readonly NativeCanonicalCatalogRecord[]
): readonly string[] | undefined {
  const fingerprint = catalogFingerprint(records);
  if (current.observedCatalogFingerprint === fingerprint) {
    return undefined;
  }
  const before = current.observedCatalogRecords ?? [];
  current.observedCatalogRecords = records;
  current.observedCatalogFingerprint = fingerprint;
  current.publication?.invalidateScope({
    embeddingSetId: current.settings.managedCollectionId,
    kind: 'collection',
  });
  const changedRoots = [...current.leases.keys()].filter(
    (rootId) =>
      catalogFingerprint(before.filter((record) => record.rootId === rootId)) !==
      catalogFingerprint(records.filter((record) => record.rootId === rootId))
  );
  for (const rootId of changedRoots) {
    current.publication?.invalidateScope({ kind: 'workspace', rootId });
  }
  return changedRoots;
}
