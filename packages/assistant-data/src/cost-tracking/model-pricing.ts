import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  listProviderEmbeddingModels,
  listProviderLlmModels,
} from '@brainstrike/assistant-contract/provider-registry';
import type { ModelPricingResolver } from '../assistant-cross-root-cost';

/**
 * Resolve a model's list price from the static provider registry. Returns
 * undefined for unknown providers/models (keyless/local) — `computeCost` then
 * reports `unpriced_model` and the row renders "cost unavailable", never $0.
 * Shared by the cost-aggregation panel and the Task Ledger panel so their
 * honest-cost behavior can never drift.
 */
export const resolveModelPricing: ModelPricingResolver = (provider, model) => {
  if (!isSupportedProvider(provider)) {
    return;
  }
  const llm = listProviderLlmModels(provider).find((candidate) => candidate.id === model);
  if (llm) {
    return llm.pricing;
  }
  // BST-2226: a hosted memory embedder bills its input tokens and no output.
  const embedding = listProviderEmbeddingModels(provider).find(
    (candidate) => candidate.id === model
  )?.pricing;
  return embedding && { inputPerMTok: embedding.inputPerMTok, outputPerMTok: 0 };
};
