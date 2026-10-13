import { randomUUID } from 'node:crypto';
import type {
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { getDatabase } from './db-main';
import type { DesktopProfileRuntime } from './desktop-profile-runtime';
import type { EmbeddingHostManager } from './embedding-host-manager';
import type { ApplicationIpcDomain } from './ipc-handlers';
import {
  decodeNativeCanonicalCatalogRecords,
  type NativeCanonicalCatalogRecord,
} from './native-canonical-catalog';
import type { createNativeCanonicalPublication } from './native-canonical-publication';
import { catalogPartition } from './native-index-partition';
import type { NativeIndexSettings } from './native-index-settings';
import type { NativeIndexSources } from './native-index-source-retirement';

export interface NativeIndexActivationGraph {
  readonly controller: AbortController;
  readonly generation: number;
  readonly leases: Map<string, CanonicalWorkspaceLease>;
  observedCatalogFingerprint?: string;
  observedCatalogRecords?: readonly NativeCanonicalCatalogRecord[];
  publication?: ReturnType<typeof createNativeCanonicalPublication>;
  queuedCatalogRecords?: readonly NativeCanonicalCatalogRecord[] | undefined;
  settings: NativeIndexSettings;
  sources?: NativeIndexSources | undefined;
  readonly watchFailures: Map<string, string>;
}

export const nativeGraphContext = (
  current: NativeIndexActivationGraph
): CanonicalOperationContext => ({
  requestId: randomUUID(),
  signal: current.controller.signal,
});

export async function loadNativeGraphRecords(
  current: NativeIndexActivationGraph,
  assertCurrent: (current: NativeIndexActivationGraph) => void
): Promise<readonly NativeCanonicalCatalogRecord[]> {
  assertCurrent(current);
  const database = await getDatabase();
  const partition = catalogPartition(current.settings);
  const result = await database.query<NativeCanonicalCatalogRecord>(
    `SELECT id::text AS "fileId", name AS "fileName", path, root_id AS "rootId",
       embedding_set_id::text AS "embeddingSetId", content_hash AS "contentHash",
       (chunks_processed_at IS NOT NULL) AS "chunksProcessed", NULL::text AS content,
       json_build_object('mtimeMs',mtime_ms,'size',size) AS stat
       FROM file_records WHERE ${partition.predicate} ORDER BY id`,
    [...partition.params]
  );
  assertCurrent(current);
  const records = decodeNativeCanonicalCatalogRecords(result.rows);
  if (
    records.some((record) => record.embeddingSetId !== current.settings.managedCollectionId) ||
    new Set(records.map((record) => record.fileId)).size !== records.length
  ) {
    throw new Error('Canonical catalog returned duplicated or unauthorized file identities.');
  }
  return records;
}

export interface NativeIndexActivationDependencies {
  readonly application: ApplicationIpcDomain;
  readonly embedding: Pick<EmbeddingHostManager, 'documentEmbeddings'>;
  readonly onError: (operation: string, error: unknown) => void;
  readonly onReceipt?: (receipt: CanonicalScanReceipt) => void;
  readonly profile: DesktopProfileRuntime<HostAttachment>;
  readonly storage: Pick<ElectronStorageAdapter, 'getItem'>;
}
