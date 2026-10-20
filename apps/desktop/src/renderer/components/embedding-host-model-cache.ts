import { readModelCacheStatus } from '@brainstrike/embedding-worker';
import { resolveViteEmbeddingWorkerUrlHref } from '@brainstrike/embedding-worker/vite';
import {
  assertEmbeddingHostModelCacheRequest,
  createEmbeddingHostModelCacheErrorReport,
  createEmbeddingHostModelCacheResultReport,
  type EmbeddingHostModelCacheResponseReport,
} from '../../embedding-host-model-cache';

/**
 * Answers one of Main's model cache requests (BST-2241): a short-lived embedding
 * worker of this host, the realm whose cache indexing and downloads use, reads
 * which plans are fully cached. Nothing is fetched or loaded.
 */
export async function answerModelCacheRequest(
  raw: unknown,
  report: (response: EmbeddingHostModelCacheResponseReport) => void
): Promise<void> {
  const request = assertEmbeddingHostModelCacheRequest(raw);
  try {
    const cached = await readModelCacheStatus(
      resolveViteEmbeddingWorkerUrlHref(),
      request.payload.plans
    );
    report(createEmbeddingHostModelCacheResultReport(request, cached));
  } catch (error) {
    report(createEmbeddingHostModelCacheErrorReport(request, error));
  }
}
