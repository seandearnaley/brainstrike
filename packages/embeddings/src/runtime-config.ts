import type { QueueAdapter } from '@brainstrike/queue';

export interface RegisteredEmbeddingRuntimeConfig {
  readonly streamingWorkerUrl: string;
}

type EmbeddingQueueFactory = () => QueueAdapter | Promise<QueueAdapter>;

let customQueueFactory: EmbeddingQueueFactory | null = null;
let registeredEmbeddingRuntimeConfig: RegisteredEmbeddingRuntimeConfig | null = null;

export function registerEmbeddingQueueFactory(factory: EmbeddingQueueFactory): void {
  customQueueFactory = factory;
}

export function resetEmbeddingQueueFactory(): void {
  customQueueFactory = null;
}

export function getRegisteredEmbeddingQueueFactory(): EmbeddingQueueFactory | null {
  return customQueueFactory;
}

export function registerEmbeddingRuntimeConfig(config: RegisteredEmbeddingRuntimeConfig): void {
  if (!(typeof config.streamingWorkerUrl === 'string' && config.streamingWorkerUrl.length > 0)) {
    throw new Error('registerEmbeddingRuntimeConfig requires a non-empty streamingWorkerUrl.');
  }
  registeredEmbeddingRuntimeConfig = {
    streamingWorkerUrl: config.streamingWorkerUrl,
  };
}

export function resetEmbeddingRuntimeConfig(): void {
  registeredEmbeddingRuntimeConfig = null;
}

export function getRegisteredEmbeddingRuntimeConfig(): RegisteredEmbeddingRuntimeConfig | null {
  return registeredEmbeddingRuntimeConfig;
}
