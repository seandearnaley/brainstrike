import type { EmbeddingModelConfig as ModelConfig } from '@brainstrike/indexing-contract';

export interface ModelDownloadProgress {
  progress?: number;
}

export interface EmbeddingModelDownloadOptions {
  cacheDir?: string;
  modelConfig?: ModelConfig;
  onProgress?: (progress: ModelDownloadProgress) => void;
}

/**
 * BST-2230: the text a Settings download embeds. Loading the model for it is
 * the download: the app's embedding realm fetches the model's files into the
 * cache its indexing reads.
 */
export const EMBEDDING_MODEL_DOWNLOAD_TEXT = 'Brainstrike model download.';

export interface ModelRuntimeServices {
  downloadEmbeddingModel: (
    modelId: string,
    options?: EmbeddingModelDownloadOptions
  ) => Promise<void>;
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
