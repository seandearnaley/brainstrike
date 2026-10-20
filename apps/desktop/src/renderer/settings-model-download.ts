import {
  catalogModelCachePlan,
  unpinnedCatalogEmbeddingPlan,
} from '@brainstrike/embeddings/inference-plan';
import type {
  CatalogEmbeddingModel,
  ModelCachePlan,
  WebGpuAdapterAvailability,
} from '@brainstrike/indexing-contract';
import { EMBEDDING_MODEL_DOWNLOAD_TEXT } from '@brainstrike/settings-ui/settings/models/model-runtime-services';
import { generateDesktopQueryEmbedding } from './query-embeddings';

/** The saved device preference, as the vector preferences store keeps it. */
export interface DownloadDevicePreference {
  readonly devicePref: 'webgpu' | 'wasm';
  readonly devicePrefConfigured: boolean;
}

/**
 * The device an unpinned load runs on, by the hidden host's own rule: a saved
 * device, else WebGPU when the host's detection finds an adapter. WASM is never
 * chosen automatically; it is the user's setting to pick.
 */
export async function resolveModelDownloadDevice(
  preference: DownloadDevicePreference,
  detectWebGpu: () => Promise<WebGpuAdapterAvailability>
): Promise<'webgpu' | 'wasm'> {
  if (preference.devicePrefConfigured) {
    return preference.devicePref;
  }
  const adapter = await detectWebGpu();
  if (adapter.available) {
    return 'webgpu';
  }
  throw new Error(
    `WebGPU is not available on this device (${adapter.reason}). Choose WASM in Settings → Search & Indexing.`
  );
}

/**
 * BST-2230: the hidden embedding host loads the catalog model's own plan (its
 * pinned revision, the device's dtype and its pooling), as indexing does, into
 * the cache indexing reads (ADR-0007). The visible renderer loads no model.
 */
export async function downloadDesktopEmbeddingModel(
  model: CatalogEmbeddingModel,
  device: 'webgpu' | 'wasm',
  signal: AbortSignal
): Promise<void> {
  const plan = unpinnedCatalogEmbeddingPlan(model, device);
  await generateDesktopQueryEmbedding(
    {
      dimensions: plan.dimensions,
      inferencePlan: plan,
      modelId: plan.modelId,
      modelKey: `local::${plan.modelId}`,
      query: EMBEDDING_MODEL_DOWNLOAD_TEXT,
    },
    { signal }
  );
}

/**
 * BST-2241: the models whose download plans on `device` are fully in the hidden
 * embedding host's model cache, the cache indexing reads. The host's own
 * embedding worker reads it; this renderer loads nothing.
 */
export async function readDesktopDownloadedEmbeddingModels(
  models: readonly CatalogEmbeddingModel[],
  device: 'webgpu' | 'wasm',
  readHostCache: (plans: readonly ModelCachePlan[]) => Promise<readonly boolean[]>
): Promise<readonly string[]> {
  const cached = await readHostCache(models.map((model) => catalogModelCachePlan(model, device)));
  return models.flatMap((model, index) => (cached[index] === true ? [model.id] : []));
}
