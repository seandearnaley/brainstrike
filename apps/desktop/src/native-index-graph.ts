import { randomUUID } from 'node:crypto';
import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import type {
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import type { HostAttachment } from '@brainstrike/host-lease';
import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { DesktopProfileRuntime } from './desktop-profile-runtime';
import type { EmbeddingHostManager } from './embedding-host-manager';
import type { ApplicationIpcDomain } from './ipc-handlers';
import {
  decodeNativeCanonicalCatalogRecords,
  type NativeCanonicalCatalogRecord,
} from './native-canonical-catalog';
import type { createNativeCanonicalPublication } from './native-canonical-publication';
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
  assertCurrent: (current: NativeIndexActivationGraph) => void,
  catalog: SourceCatalogPort
): Promise<readonly NativeCanonicalCatalogRecord[]> {
  assertCurrent(current);
  const result = await catalog.sourceCatalog({
    embeddingSetId: current.settings.managedCollectionId,
    operation: 'inventory',
  });
  assertCurrent(current);
  const records = decodeNativeCanonicalCatalogRecords(result.files);
  if (
    records.some((record) => record.embeddingSetId !== current.settings.managedCollectionId) ||
    new Set(records.map((record) => record.fileId)).size !== records.length
  ) {
    throw new Error('Canonical catalog returned duplicated or unauthorized file identities.');
  }
  // Retained rows of disconnected or ungranted folders remain outside this
  // leased authority until that same canonical root is connected again (BST-1990).
  return records.filter((record) =>
    record.rootId === null
      ? current.settings.managedCollectionId !== null
      : current.leases.has(record.rootId)
  );
}

export interface NativeIndexActivationDependencies {
  readonly application: ApplicationIpcDomain;
  readonly catalog: SourceCatalogPort & WorkspaceRootPort & CollectionPort;
  readonly embedding: Pick<EmbeddingHostManager, 'documentEmbeddings'>;
  readonly modelCatalog: Pick<ModelCatalogCapability, 'read'>;
  readonly onError: (operation: string, error: unknown) => void;
  readonly onReceipt?: (receipt: CanonicalScanReceipt) => void;
  readonly profile: DesktopProfileRuntime<HostAttachment>;
  readonly storage: Pick<ElectronStorageAdapter, 'getItem'>;
}
