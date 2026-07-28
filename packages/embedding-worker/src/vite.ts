import embeddingWorkerUrlHref from './embedding.worker.ts?worker&url';

/**
 * Returns the Vite-emitted worker asset URL. Import this source-only entry from
 * Vite renderer bundles; non-Vite runtimes use `worker-url.ts` instead.
 */
export function resolveViteEmbeddingWorkerUrlHref(): string {
  return embeddingWorkerUrlHref;
}
