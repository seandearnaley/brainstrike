import { randomUUID } from 'node:crypto';
import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import type { WorkspaceRootRegistry } from '@brainstrike/assistant-service/node-workspace-services';
import type {
  CanonicalHostedEmbeddings,
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalWorkspaceLease,
  createNativeCanonicalPublication,
} from '@brainstrike/canonical-ingestion';
import {
  loadPartitionRecords,
  type NativeCanonicalCatalogRecord,
  type NativeCanonicalInferenceDependencies,
  type NativeCanonicalProfileDependencies,
  NativeCanonicalProfileResolver,
} from '@brainstrike/canonical-ingestion';
import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type { DesktopProfileRuntime } from './desktop-profile-runtime';
import type { WorkspaceRootWatchOwner } from './ipc-domains/workspace-root-watch-owner';
import type { ForkLentUtility } from './lent-utility';
import type { LifecycleDelaySeam } from './lifecycle-delay-seam';
import { vectorCollectionId } from './native-index-partition';
import type { NativeIndexSettings } from './native-index-settings';
import { desktopSetupRequired } from './native-index-setup-required';
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
  ports: Pick<NativeCanonicalProfileDependencies, 'collections' | 'modelCatalog'>
): NativeCanonicalProfileResolver {
  return new NativeCanonicalProfileResolver({
    ...ports,
    readLocalSelection: async () => {
      assertCurrent(current);
      return current.settings.selection ?? undefined;
    },
    resolveEmbeddingSetId: async (scope) => {
      assertCurrent(current);
      const collectionId = vectorCollectionId(current.settings);
      if (!current.leases.has(scope.rootId)) {
        throw new Error('Canonical profile scope is not authorized by current desktop settings.');
      }
      return collectionId;
    },
    setupRequired: desktopSetupRequired,
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

/** The index's life inside its profile's host: it opens with the host and closes with it. */
export type NativeIndexProfile = Pick<
  DesktopProfileRuntime<unknown>,
  'acquire' | 'isRetiring' | 'retire' | 'retireFailed'
>;

export interface NativeIndexActivationDependencies {
  /** The host's mounted folders and their one watcher each, which the index borrows. */
  readonly application: {
    readonly roots: WorkspaceRootRegistry;
    readonly watches: WorkspaceRootWatchOwner;
  };
  readonly catalog: SourceCatalogPort & WorkspaceRootPort & CollectionPort;
  /** The index database, in the profile directory. */
  readonly databasePath: string;
  /** Main's embedding renderer, lent to the index: its document embeddings and its restart. */
  readonly embedding: NativeCanonicalInferenceDependencies['transport'] & {
    destroyAndRestart(): Promise<unknown>;
  };
  /** Main's fork of the index utilities (ADR-0030 decision 1). */
  readonly forkLentUtility: ForkLentUtility;
  /** Hosted providers' document embeddings, with this host's credentials. */
  readonly hostedEmbeddings: CanonicalHostedEmbeddings;
  /** Main's E2E delay seam accessor for the indexer host, read at its boundaries; absent, none. */
  readonly lifecycleDelays?: () => LifecycleDelaySeam;
  readonly modelCatalog: Pick<ModelCatalogCapability, 'read'>;
  readonly onError: (operation: string, error: unknown) => void;
  readonly onReceipt?: (receipt: CanonicalScanReceipt) => void;
  readonly profile: NativeIndexProfile;
  /** Waits before each automatic re-open of a transient startup failure; defaults apply. */
  readonly reopenDelaysMs?: readonly number[];
  /** Main's search index config, as the native index runs it. */
  readonly settings: () => Promise<NativeIndexSettings>;
}
