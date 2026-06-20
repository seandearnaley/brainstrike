import {
  type CostEstimate,
  computeCost,
  type ModelTokenPricing,
} from '@brainstrike/utils/token-counting-heuristics';
import type { ThreadCumulativeUsage } from './assistant-memory-repository';

/**
 * Resolved cumulative-usage view for the context meter. Tokens are the durable
 * thread total; `cost` is a discriminated CostEstimate (never $0 for an
 * unavailable price — see the no-silent-fallbacks rule).
 */
export interface CumulativeUsageDisplay {
  readonly cost: CostEstimate;
  readonly totalTokens: number;
}

/** Resolves a model's pricing from the registry (undefined when unknown / keyless). */
export type ModelPricingResolver = (
  provider: string,
  model: string
) => ModelTokenPricing | undefined;

/**
 * Aggregate durable per-model usage into a single cumulative display value.
 *
 * Cost is summed ACROSS MODELS: each per-model subtotal is priced with that
 * model's own registry rate, then totalled. A thread that mixed a priced and an
 * unpriced model is reported as `unpriced_model` overall — partial cost would be
 * a silent under-count, which the no-silent-fallbacks rule forbids.
 */
export function resolveCumulativeUsageDisplay(
  usage: ThreadCumulativeUsage | null,
  resolvePricing: ModelPricingResolver
): CumulativeUsageDisplay | null {
  if (!usage) {
    return null;
  }

  const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;

  let summedUsd = 0;
  let sawAnyRow = false;
  for (const entry of usage.perModel) {
    sawAnyRow = true;
    const pricing = resolvePricing(entry.provider, entry.model);
    const entryCost = computeCost(
      { inputTokens: entry.inputTokens, outputTokens: entry.outputTokens },
      pricing
    );
    if (!entryCost.available) {
      // Any unpriced model makes the whole-thread cost honestly unavailable.
      return { totalTokens, cost: { available: false, reason: 'unpriced_model' } };
    }
    summedUsd += entryCost.usdAmount;
  }

  if (!sawAnyRow) {
    // A non-null usage with no per-model rows should not happen (the repo
    // returns null for an empty thread), but treat it as unpriced rather than
    // fabricating a $0.
    return { totalTokens, cost: { available: false, reason: 'unpriced_model' } };
  }

  return {
    totalTokens,
    cost: { available: true, usdAmount: summedUsd, provenance: 'exact-pricing' },
  };
}
