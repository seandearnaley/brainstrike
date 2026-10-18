import { refusalError } from '@brainstrike/assistant-contract';
import { parseSemanticRecallEmbeddingModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import { resolveNativeCanonicalProfile } from '@brainstrike/canonical-ingestion';
import {
  type CatalogEmbeddingWorkerPlan,
  unpinnedCatalogEmbeddingPlan,
} from '@brainstrike/embeddings/inference-plan';
import type { VectorProfile } from '@brainstrike/indexer';
import type { CatalogEmbeddingModel } from '@brainstrike/indexing-contract';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import { waitForHostStartup } from '../embedding-host-startup';
import { desktopSetupRequired } from '../native-index-setup-required';
import type { PlatformSelection } from './platform-wire';

/** Main's admitted recall embedding: the wire profile, plus the local worker plan it keeps. */
export interface DesktopMemoryVectorSelection {
  /** Main-only: the exact local plan sent with each borrowed query. */
  readonly local?: {
    readonly modelKey: string;
    readonly workerPlan: CatalogEmbeddingWorkerPlan;
  };
  readonly profile: VectorProfile;
}

export interface DesktopMemoryVectorSources {
  /** A hosted model's catalog dimensions; an unknown model throws. */
  readDimensions(provider: string, modelId: string): Promise<number>;
  /** The device the embedding host resolved for unpinned loads; rejects with its reason. */
  readLocalDevice(): Promise<'webgpu' | 'wasm'>;
  /** A local model's catalog row (dimensions, pooling, pins); an unknown model throws. */
  readLocalModel(modelId: string): Promise<CatalogEmbeddingModel>;
}

/**
 * Recall and vector OM embed with the semantic recall target, which is
 * independent of Search & Indexing, as it was before host threads. A local
 * target loads the way the embedding host's unpinned catalog query did (its
 * device, and the shared dtype rule), and that plan is pinned, so a changed
 * device is a new profile rather than mixed vectors.
 */
export async function resolveDesktopMemoryVectors(
  settings: PlatformSelection['memory']['settings'],
  sources: DesktopMemoryVectorSources
): Promise<DesktopMemoryVectorSelection | undefined> {
  const { observationalMemory: observation, semanticRecall } = settings;
  if (
    !(semanticRecall.enabled || (observation.enabled && observation.retrievalMode === 'vector'))
  ) {
    return undefined;
  }
  if (!semanticRecall.embeddingModelTarget?.trim()) {
    throw new Error('Memory vectors require the selected semantic recall embedding model target');
  }
  const target = parseSemanticRecallEmbeddingModelTarget(semanticRecall.embeddingModelTarget);
  const modelKey = `${target.provider}::${target.model}`;
  const local = target.provider === 'local' ? await sources.readLocalModel(target.model) : null;
  const dimensions = local
    ? local.dimensions
    : await sources.readDimensions(target.provider, target.model);
  const resolved = resolveNativeCanonicalProfile(
    {
      dimensions,
      distance: 'cosine',
      id: `memory:${modelKey}`,
      modelId: target.model,
      modelKey,
    },
    local ? unpinnedCatalogEmbeddingPlan(local, await sources.readLocalDevice()) : undefined,
    local ?? undefined,
    desktopSetupRequired
  );
  return {
    profile: resolved.profile,
    ...(resolved.workerPlan ? { local: { modelKey, workerPlan: resolved.workerPlan } } : {}),
  };
}

/**
 * The device the running embedding host resolved for unpinned loads. A device it
 * cannot resolve (no WebGPU and no saved device) is a memory setting this
 * machine cannot run, refused with the host's reason and the user's remedy.
 */
export async function readEmbeddingHostDevice(
  host: Pick<EmbeddingHostManager, 'ensureDeviceResolved'>,
  signal: AbortSignal
): Promise<'webgpu' | 'wasm'> {
  const status = await waitForHostStartup(host.ensureDeviceResolved(), signal);
  if (status.state !== 'running') {
    throw new Error(status.lastError ?? 'The embedding host is not running.');
  }
  const runtime = status.embeddingRuntime;
  if (runtime?.hostDevice) {
    return runtime.hostDevice;
  }
  if (runtime?.hostDeviceError) {
    throw refusalError(
      'configuration',
      'memory.embedder-device-unavailable',
      `The on-device memory embedder has no execution device: ${runtime.hostDeviceError} Choose a hosted embedding model in Settings → Assistant Memory, or turn off semantic recall and vector observation retrieval.`
    );
  }
  throw new Error('The embedding host has not resolved its execution device.');
}
