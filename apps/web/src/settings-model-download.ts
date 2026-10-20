import type { CatalogModelFacts } from '@brainstrike/embeddings/inference-plan';
import { EMBEDDING_MODEL_DOWNLOAD_TEXT } from '@brainstrike/settings-ui/settings/models/model-runtime-services';

/**
 * BST-2230: the embedding worker loads the catalog model's own plan (its pinned
 * revision, the device's dtype and its pooling) on the saved device, as web
 * indexing does, into the cache it reads; the page itself loads no model.
 */
export async function downloadWebEmbeddingModel(
  model: CatalogModelFacts,
  device: 'webgpu' | 'wasm'
): Promise<void> {
  const [{ SimpleEmbeddingService }, { unpinnedCatalogEmbeddingPlan }, { pinnedPlanModelConfig }] =
    await Promise.all([
      import('@brainstrike/embeddings/service'),
      import('@brainstrike/embeddings/inference-plan'),
      import('@brainstrike/embeddings/pinned-plan'),
    ]);
  const plan = unpinnedCatalogEmbeddingPlan(model, device);
  const service = new SimpleEmbeddingService();
  try {
    await service.initialize({ ...plan, modelConfig: pinnedPlanModelConfig(plan) });
    await service.generateQueryEmbedding(EMBEDDING_MODEL_DOWNLOAD_TEXT);
  } finally {
    await service.dispose();
  }
}
