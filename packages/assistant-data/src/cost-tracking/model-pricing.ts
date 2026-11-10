import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  getProviderDefinition,
  listProviderLlmModels,
  pricingInForceAt,
} from '@brainstrike/assistant-contract/provider-registry';
import type { ModelPricingResolver } from '../assistant-cross-root-cost.ts';

/**
 * Resolve the list price a call ran at from the static provider registry: the
 * rates in force at `atMs`, so a dated price change reprices only the calls
 * made after it. Returns undefined for unknown providers/models, and for a
 * call of unknown time on a model whose price changed — `computeCost` then
 * reports `unpriced_model` and the row renders "cost unavailable", never $0
 * or a guessed rate. Shared by the cost-aggregation panel and the Task Ledger
 * panel so their honest-cost behavior can never drift.
 */
export const resolveModelPricing: ModelPricingResolver = (provider, model, atMs) => {
  if (!isSupportedProvider(provider)) {
    return;
  }
  const pricing = listProviderLlmModels(provider).find(
    (candidate) => candidate.id === model
  )?.pricing;
  if (pricing === undefined) {
    return;
  }
  if (atMs !== undefined) {
    return pricingInForceAt(pricing, atMs);
  }
  // A call of unknown time has one price only when the model's never changed.
  const changeCount = pricing.changes?.length ?? 0;
  return changeCount === 0 ? pricingInForceAt(pricing, Number.NEGATIVE_INFINITY) : undefined;
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

/** Whether a stream the client cuts off still bills (true unless the provider declares it does not). */
export function providerBillsCutOffStreams(provider: string): boolean {
  return (
    !isSupportedProvider(provider) || getProviderDefinition(provider).billsCutOffStreams !== false
  );
}
