import {
  isSupportedProvider,
  MEMORY_EMBEDDER_SELECTION_REMEDY,
  MEMORY_FAILURE_CODES,
  type ModelCatalogCapability,
  refusalError,
} from '@brainstrike/assistant-contract';
import { listEmbeddingModels } from '@brainstrike/assistant-contract/provider-metadata';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { RetrievalStore } from '../assistant-server/retrieval-store';
import { loadWorkspaceRootsFromCatalog } from '../assistant-server/workspace-roots';
import { desktopHostToolServices } from './desktop-host-tool-runtime';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import type { DesktopWorkspaceBindingAuthority } from './desktop-workspace-binding';
import type { DesktopPlatformCapabilities } from './main-platform';
import { resolveDesktopMemoryVectors } from './memory-vector-selection';

/** Supplied by the existing settings owner, never parsed from client configuration. */
export type DesktopCliOwnerIntentReader = NonNullable<DesktopAdmissionReads['cliOwnerIntent']>;

/** Main's tool services for host threads. */
export interface DesktopHostToolServices {
  readonly modelCatalog: Pick<ModelCatalogCapability, 'read'>;
  readonly nativeIndexSearch?: IndexSearchCapability | undefined;
  readonly retrievalStore: RetrievalStore;
  readonly workspaceRoots: WorkspaceRootPort;
}

/** A hosted recall embedder's catalog dimensions, from the provider registry. */
function readHostedEmbeddingDimensions(provider: string, modelId: string): number {
  const model = isSupportedProvider(provider)
    ? listEmbeddingModels(provider).find((candidate) => candidate.id === modelId)
    : undefined;
  if (!model) {
    throw refusalError(
      'configuration',
      MEMORY_FAILURE_CODES.configuration,
      `The semantic recall embedding model ${provider}/${modelId} is not in the provider catalog.`,
      MEMORY_EMBEDDER_SELECTION_REMEDY
    );
  }
  return model.defaultDimension;
}

/**
 * The facts a host-composed run admission reads from Main (BST-1930 stage e):
 * the model catalog and live roots in Main's database and the live binding
 * authority.
 */
function desktopAdmissionReads(
  dependencies: DesktopHostToolServices,
  readCliOwnerIntent: DesktopCliOwnerIntentReader | undefined,
  workspaceAuthority: DesktopWorkspaceBindingAuthority | undefined
): DesktopAdmissionReads {
  return {
    acquireWorkspace: async (request) => {
      if (!workspaceAuthority) {
        throw new Error('Desktop run has no live workspace binding owner');
      }
      return await workspaceAuthority.acquire(request);
    },
    catalogModel: async ({ model, provider }) => {
      const row = (await dependencies.modelCatalog.read()).models.find(
        (candidate) => candidate.id === model && candidate.providerId === provider
      );
      return row
        ? { isEnabled: row.isEnabled, providerId: row.providerId, type: row.capabilities.type }
        : null;
    },
    ...(readCliOwnerIntent ? { cliOwnerIntent: readCliOwnerIntent } : {}),
    /**
     * The auto-observer candidates the model catalog has enabled: provider and
     * model rows enabled and the model an LLM, the gate the memory settings
     * dropdown applies (main's resolveEffectiveObservationalMemorySettings).
     */
    enabledObservers: async (candidates) => {
      const snapshot = await dependencies.modelCatalog.read();
      const enabledProviders = new Set(
        snapshot.providers.filter((provider) => provider.isEnabled).map((provider) => provider.id)
      );
      return snapshot.models
        .filter(
          (model) =>
            model.isEnabled &&
            model.capabilities.type === 'llm' &&
            enabledProviders.has(model.providerId) &&
            candidates.includes(`${model.providerId}/${model.id}`)
        )
        .map((model) => `${model.providerId}/${model.id}`);
    },
    indexStatus: async () =>
      dependencies.nativeIndexSearch
        ? await dependencies.nativeIndexSearch.status()
        : { kind: 'unavailable', reason: 'This desktop has no workspace index.' },
    liveWorkspaceRoots: async () =>
      await loadWorkspaceRootsFromCatalog(dependencies.workspaceRoots),
    memoryVectors: async (settings) =>
      await resolveDesktopMemoryVectors(settings, {
        readDimensions: async (provider, modelId) =>
          readHostedEmbeddingDimensions(provider, modelId),
      }),
  };
}

/** Lazy borrows: Root/New Thread never waits for indexing or credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopHostToolServices,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader,
  workspaceAuthority?: DesktopWorkspaceBindingAuthority
): Omit<DesktopPlatformCapabilities, 'mcp'> {
  return {
    admission: desktopAdmissionReads(dependencies, readCliOwnerIntent, workspaceAuthority),
    ...(workspaceAuthority
      ? { validateWorkspaceBinding: workspaceAuthority.validateWorkspaceBinding }
      : {}),
    hostTools: desktopHostToolServices(dependencies),
    resolveWorkspaceRoot: async (rootId) => {
      const root = (await loadWorkspaceRootsFromCatalog(dependencies.workspaceRoots)).find(
        (candidate) => candidate.rootId === rootId
      );
      if (!root) {
        throw new Error('The workspace root is no longer mounted');
      }
      return root.path;
    },
  };
}
