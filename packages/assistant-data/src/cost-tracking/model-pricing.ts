import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  getProviderDefinition,
  listProviderLlmModels,
} from '@brainstrike/assistant-contract/provider-registry';
import type { ModelPricingResolver } from '../assistant-cross-root-cost.ts';

/**
 * Resolve a model's list price from the static provider registry. Returns
 * undefined for unknown providers/models — `computeCost` then
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

/**
 * What a provider bills for each search its native web search tool runs, from
 * the same static registry; undefined when the provider declares no price.
 */
export function resolveNativeWebSearchUsdPerCall(provider: string): number | undefined {
  return isSupportedProvider(provider)
    ? getProviderDefinition(provider).nativeWebSearchUsdPerCall
    : undefined;
}
