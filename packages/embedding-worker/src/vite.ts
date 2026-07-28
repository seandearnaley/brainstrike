import embeddingWorkerUrlHref from './embedding.worker.ts?worker&url';

export function resolveEmbeddingWorkerUrlHref(): string {
  return embeddingWorkerUrlHref;
}
