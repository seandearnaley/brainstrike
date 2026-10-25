import {
  BoundaryFailureError,
  fault,
  isSupportedProvider,
  MEMORY_EMBEDDER_SELECTION_REMEDY,
  MEMORY_FAILURE_CODES,
  MEMORY_ON_DEVICE_EMBEDDER_REMEDY,
  type ModelCatalogCapability,
  refusalError,
} from '@brainstrike/assistant-contract';
import { listEmbeddingModels } from '@brainstrike/assistant-contract/provider-metadata';
import {
  type CatalogEmbeddingModel,
  decodeCatalogEmbeddingModel,
} from '@brainstrike/indexing-contract';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { resolveOllamaModelForAdmission } from '../ipc-runtime';
import { desktopHostToolServices } from './desktop-host-tool-runtime';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import type { DesktopPlatformCapabilities, MainAdmissionReads } from './main-platform';
import { resolveDesktopMemoryVectors } from './memory-vector-selection';

/** Supplied by the existing settings owner, never parsed from client configuration. */
export type DesktopCliOwnerIntentReader = NonNullable<DesktopAdmissionReads['cliOwnerIntent']>;

/** Main's services a host's run admission reads. */
export interface DesktopAdmissionServices {
  readonly embeddingHostManager?:
    | Pick<
        EmbeddingHostManager,
        'destroyAndRestart' | 'documentEmbeddings' | 'queryEmbedding' | 'stop'
      >
    | undefined;
  readonly modelCatalog: Pick<ModelCatalogCapability, 'read'>;
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

/** A local recall embedder's facts are projected from the one canonical model catalog. */
async function readLocalEmbeddingModel(
  catalog: Pick<ModelCatalogCapability, 'read'>,
  modelId: string
): Promise<CatalogEmbeddingModel> {
  const row = (await catalog.read()).models.find(
    (model) => model.id === modelId && model.providerId === 'local'
  );
  if (!row) {
    throw refusalError(
      'configuration',
      MEMORY_FAILURE_CODES.configuration,
      `The semantic recall embedding model local/${modelId} is not in the model catalog.`,
      MEMORY_EMBEDDER_SELECTION_REMEDY
    );
  }
  return decodeCatalogEmbeddingModel(row);
}

async function readLocalEmbeddingHostDevice(
  read: ((signal: AbortSignal) => Promise<'webgpu' | 'wasm'>) | undefined,
  signal: AbortSignal
): Promise<'webgpu' | 'wasm'> {
  if (!read) {
    throw new BoundaryFailureError(
      fault({
        category: 'availability',
        code: MEMORY_FAILURE_CODES.embedderUnavailable,
        message: 'This desktop has no embedding host for the on-device memory embedder.',
        remedy: MEMORY_ON_DEVICE_EMBEDDER_REMEDY,
      }),
      { cause: new Error('Local Memory vectors require the embedding host') }
    );
  }
  return await read(signal);
}

/**
 * The facts a host-composed run admission reads from Main (BST-1930 stage e):
 * the model catalog, the local runtimes and the embedding host.
 */
function desktopAdmissionReads(
  dependencies: DesktopAdmissionServices,
  readCliOwnerIntent: DesktopCliOwnerIntentReader | undefined,
  readLocalEmbeddingDevice: ((signal: AbortSignal) => Promise<'webgpu' | 'wasm'>) | undefined
): MainAdmissionReads {
  return {
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
    localRuntimeModel: async ({ endpoint, model }, signal) => {
      const result = await resolveOllamaModelForAdmission(model, endpoint, signal);
      return result.state === 'resolved'
        ? {
            contextLength: result.contextLength,
            endpoint: result.endpoint,
            state: 'resolved',
            thinking: result.thinking,
          }
        : { endpoint: result.endpoint, message: result.message, state: 'unavailable' };
    },
    memoryVectors: async (settings, signal) =>
      await resolveDesktopMemoryVectors(settings, {
        readDimensions: async (provider, modelId) =>
          readHostedEmbeddingDimensions(provider, modelId),
        readLocalDevice: () => readLocalEmbeddingHostDevice(readLocalEmbeddingDevice, signal),
        readLocalModel: (modelId) => readLocalEmbeddingModel(dependencies.modelCatalog, modelId),
      }),
  };
}

/** Lazy borrows: Root/New Thread never waits for indexing or credential initialization. */
export function productionDesktopCapabilities(
  dependencies: DesktopAdmissionServices,
  readCliOwnerIntent?: DesktopCliOwnerIntentReader,
  readLocalEmbeddingDevice?: (signal: AbortSignal) => Promise<'webgpu' | 'wasm'>
): Omit<DesktopPlatformCapabilities, 'mcp'> {
  return {
    admission: desktopAdmissionReads(dependencies, readCliOwnerIntent, readLocalEmbeddingDevice),
    hostTools: desktopHostToolServices,
    ...(dependencies.embeddingHostManager
      ? { localEmbedding: dependencies.embeddingHostManager }
      : {}),
  };
}
