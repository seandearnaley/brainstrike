import type { EmbeddingModelConfig as ModelConfig } from '@brainstrike/indexing-contract';

export interface ModelDownloadProgress {
  progress?: number;
}

export interface EmbeddingModelDownloadOptions {
  cacheDir?: string;
  modelConfig?: ModelConfig;
  onProgress?: (progress: ModelDownloadProgress) => void;
}

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
