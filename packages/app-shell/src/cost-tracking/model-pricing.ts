import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { listProviderLlmModels } from '@brainstrike/assistant-contract/provider-registry';
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
  return listProviderLlmModels(provider).find((candidate) => candidate.id === model)?.pricing;
};
