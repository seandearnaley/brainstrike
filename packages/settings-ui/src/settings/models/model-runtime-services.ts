import type { CatalogEmbeddingModel } from '@brainstrike/indexing-contract';

/**
 * BST-2230: the text a Settings download embeds. Loading the model for it is
 * the download: the app's embedding realm fetches the model's files into the
 * cache its indexing reads.
 */
export const EMBEDDING_MODEL_DOWNLOAD_TEXT = 'Brainstrike model download.';

export interface ModelRuntimeServices {
  /**
   * Loads the catalog model's own plan (its pinned revision, per-device dtype
   * and pooling, BST-1993) in the realm that indexes with it. No realm reports
   * byte progress, so the catalog shows the download as indeterminate.
   */
  downloadEmbeddingModel: (model: CatalogEmbeddingModel) => Promise<void>;
}

let configuredModelRuntimeServices: ModelRuntimeServices | null = null;

export function configureModelRuntimeServices(services: ModelRuntimeServices | null): void {
  configuredModelRuntimeServices = services;
}

export function getModelRuntimeServices(): ModelRuntimeServices {
  if (!configuredModelRuntimeServices) {
    throw new Error('Model runtime services have not been configured by the application.');
  }
  return configuredModelRuntimeServices;
}
