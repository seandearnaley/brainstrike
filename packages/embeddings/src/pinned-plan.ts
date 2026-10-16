import { requestedEmbeddingPooling } from '@brainstrike/indexing-contract';
import type { CatalogEmbeddingWorkerPlan } from './inference-plan.js';
import type { EmbeddingResult, ModelConfig } from './types.js';

/**
 * The model a pinned plan loads. The plan states its execution whole, so the
 * service reads no catalog row for it; desktop's embedding host and the web
 * index worker load a plan the same way.
 */
export function pinnedPlanModelConfig(plan: CatalogEmbeddingWorkerPlan): ModelConfig {
  return {
    description: 'Explicit pinned native inference',
    dimensions: plan.dimensions,
    id: plan.modelId,
    name: plan.modelId,
    quantized: false,
    tags: ['local', 'embedding'],
  };
}

/**
 * A pinned plan's result is its model's, at its dimensions, with finite values,
 * and ran exactly as the plan states: device, dtype, pooling and revision, with
 * no fallback.
 */
export function assertPinnedPlanResult(
  plan: CatalogEmbeddingWorkerPlan,
  result: EmbeddingResult
): void {
  if (
    !(
      result.model === plan.modelId &&
      result.dimensions === plan.dimensions &&
      result.embedding.length === plan.dimensions &&
      result.embedding.every(Number.isFinite)
    )
  ) {
    throw new Error('Native pinned embedding returned invalid model, dimensions or vector values.');
  }
  const runtime = result.runtime;
  if (
    !(
      runtime &&
      runtime.device === plan.device &&
      runtime.dtype === plan.dtype &&
      runtime.fallbackApplied === false &&
      runtime.pooling === requestedEmbeddingPooling(plan) &&
      runtime.revision === plan.revision
    )
  ) {
    throw new Error(
      'Native pinned query embedding returned mismatched or missing worker runtime metadata.'
    );
  }
}
