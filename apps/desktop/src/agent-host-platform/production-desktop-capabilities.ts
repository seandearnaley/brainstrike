import { isSupportedProvider, type ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { listEmbeddingModels } from '@brainstrike/assistant-contract/provider-metadata';
import {
  type CatalogEmbeddingModel,
  decodeCatalogEmbeddingModel,
} from '@brainstrike/indexing-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { RetrievalStore } from '../assistant-server/retrieval-store';
import { loadWorkspaceRootsFromCatalog } from '../assistant-server/workspace-roots';
import type { DesktopWorktreeServices } from '../assistant-server/worktree-tool-dependencies';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { desktopHostToolServices } from './desktop-host-tool-runtime';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import type { DesktopWorkspaceBindingAuthority } from './desktop-workspace-binding';
import type { DesktopPlatformCapabilities } from './main-platform';
import { resolveDesktopMemoryVectors } from './memory-vector-selection';

/** Supplied by the existing settings owner, never parsed from client configuration. */
export type DesktopCliOwnerIntentReader = NonNullable<DesktopAdmissionReads['cliOwnerIntent']>;

/** Main's tool services for host threads, resolved per run (the worktree services lazily). */
export interface DesktopHostToolServices extends DesktopWorktreeServices {
  readonly embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | undefined;
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
    throw new Error(`Embedding model "${provider}/${modelId}" is not in the provider catalog.`);
  }
  return model.defaultDimension;
}

/** A local recall embedder's facts are projected from the one canonical model catalog. */
async function readLocalEmbeddingModel(
  catalog: Pick<ModelCatalogCapability, 'read'>,
  modelId: string
): Promise<CatalogEmbeddingModel> {
  const row = (await catalog.read()).models.find(
    (model) => model.id === modelId && model.providerId === 'local'
  );
  if (!row) {
    throw new Error(`Local embedding model "${modelId}" is not in the model catalog.`);
  }
  return decodeCatalogEmbeddingModel(row);
}

async function readLocalEmbeddingHostDevice(
  read: ((signal: AbortSignal) => Promise<'webgpu' | 'wasm'>) | undefined,
  signal: AbortSignal
): Promise<'webgpu' | 'wasm'> {
  if (!read) {
    throw new Error('Local Memory vectors require the embedding host');
  }
  return await read(signal);
}

/**
 * The facts a host-composed run admission reads from Main (BST-1930 stage e):
 * the model catalog and live roots in Main's database, the live binding
 * authority, the worktree service and the embedding host.
 */
function desktopAdmissionReads(
  dependencies: DesktopHostToolServices,
  readCliOwnerIntent: DesktopCliOwnerIntentReader | undefined,
  workspaceAuthority: DesktopWorkspaceBindingAuthority | undefined,
  readLocalEmbeddingDevice: ((signal: AbortSignal) => Promise<'webgpu' | 'wasm'>) | undefined
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
      return row ? { isEnabled: row.isEnabled, providerId: row.providerId } : null;
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
    liveWorkspaceRoots: async () =>
      await loadWorkspaceRootsFromCatalog(dependencies.workspaceRoots),
    memoryVectors: async (settings, signal) =>
      await resolveDesktopMemoryVectors(settings, {
        readDimensions: async (provider, modelId) =>
          readHostedEmbeddingDimensions(provider, modelId),
        readLocalDevice: () => readLocalEmbeddingHostDevice(readLocalEmbeddingDevice, signal),
        readLocalModel: (modelId) => readLocalEmbeddingModel(dependencies.modelCatalog, modelId),
      }),
    worktreesAvailable: async () => Boolean(dependencies.resolveWorktreeService?.()),
  };
}

/** Lazy borrows: Root/New Thread never waits for indexing or credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopHostToolServices,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader,
  workspaceAuthority?: DesktopWorkspaceBindingAuthority,
  readLocalEmbeddingDevice?: (signal: AbortSignal) => Promise<'webgpu' | 'wasm'>
): Omit<DesktopPlatformCapabilities, 'mcp'> {
  return {
    admission: desktopAdmissionReads(
      dependencies,
      readCliOwnerIntent,
      workspaceAuthority,
      readLocalEmbeddingDevice
    ),
    ...(workspaceAuthority
      ? { validateWorkspaceBinding: workspaceAuthority.validateWorkspaceBinding }
      : {}),
    hostTools: desktopHostToolServices(dependencies),
    ...(dependencies.embeddingHostManager
      ? { localEmbedding: dependencies.embeddingHostManager }
      : {}),
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
