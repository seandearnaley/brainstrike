import { randomUUID } from 'node:crypto';
import type {
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalWorkspaceLease,
  createNativeCanonicalPublication,
} from '@brainstrike/canonical-ingestion';
import {
  loadPartitionRecords,
  type NativeCanonicalCatalogRecord,
  type NativeCanonicalProfileDependencies,
  NativeCanonicalProfileResolver,
} from '@brainstrike/canonical-ingestion';
import type { HostAttachment } from '@brainstrike/host-lease';
import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type { DesktopProfileRuntime } from './desktop-profile-runtime';
import type { ApplicationIpcDomain } from './ipc-handlers';
import type { LifecycleDelaySeam } from './lifecycle-delay-seam';
import { vectorCollectionId } from './native-index-partition';
import type { NativeIndexSettings } from './native-index-settings';
import type { NativeIndexSources } from './native-index-source-retirement';

export interface NativeIndexActivationGraph {
  readonly controller: AbortController;
  readonly generation: number;
  readonly leases: Map<string, CanonicalWorkspaceLease>;
  observedCatalogFingerprint?: string;
  publication?: ReturnType<typeof createNativeCanonicalPublication>;
  queuedCatalogRecords?: readonly NativeCanonicalCatalogRecord[] | undefined;
  /** Applies the queued catalog once the scan that deferred it settles (BST-2012). */
  queuedCatalogRefresh?: Promise<void> | undefined;
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

/** One graph's canonical profile resolver: its saved selection and authorized scopes. */
export function createNativeGraphProfileResolver(
  current: NativeIndexActivationGraph,
  assertCurrent: (current: NativeIndexActivationGraph) => void,
  ports: Pick<NativeCanonicalProfileDependencies, 'collections'>
): NativeCanonicalProfileResolver {
  return new NativeCanonicalProfileResolver({
    ...ports,
    resolveEmbeddingSetId: async (scope) => {
      assertCurrent(current);
      const collectionId = vectorCollectionId(current.settings);
      if (!current.leases.has(scope.rootId)) {
        throw new Error('Canonical profile scope is not authorized by current desktop settings.');
      }
      return collectionId;
    },
  });
}

export async function loadNativeGraphRecords(
  current: NativeIndexActivationGraph,
  assertCurrent: (current: NativeIndexActivationGraph) => void,
  catalog: SourceCatalogPort
): Promise<readonly NativeCanonicalCatalogRecord[]> {
  return loadPartitionRecords(
    catalog,
    current.settings,
    (rootId) => current.leases.has(rootId),
    () => assertCurrent(current)
  );
}

export interface NativeIndexActivationDependencies {
  readonly application: ApplicationIpcDomain;
  readonly catalog: SourceCatalogPort & WorkspaceRootPort & CollectionPort;
  /** Main's E2E delay seam accessor for the indexer host, read at its boundaries; absent, none. */
  readonly lifecycleDelays?: () => LifecycleDelaySeam;
  readonly onError: (operation: string, error: unknown) => void;
  readonly onReceipt?: (receipt: CanonicalScanReceipt) => void;
  readonly profile: DesktopProfileRuntime<HostAttachment>;
  /** Waits before each automatic re-open of a transient startup failure; defaults apply. */
  readonly reopenDelaysMs?: readonly number[];
  /** Main's search index config, as the native index runs it. */
  readonly settings: () => Promise<NativeIndexSettings>;
}
