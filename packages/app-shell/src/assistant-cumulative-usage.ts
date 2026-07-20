import {
  buildTokenUsageCounts,
  type CostEstimate,
  computeCost,
  type ModelTokenPricing,
} from '@brainstrike/utils/token-counting-heuristics';
import type { ThreadCumulativeUsage } from './assistant-memory-repository';

/**
 * Resolved cumulative-usage view for the context meter. Tokens are the durable
 * CAPTURED thread total; subagents, observational memory, embeddings, and some
 * paused/resumed legs are not yet itemized. `cost` therefore carries captured-
 * usage estimate provenance, never an unqualified exact-total claim.
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
 * Aggregate captured durable per-model usage into a cumulative display value.
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
  let sawEstimatedUsage = false;
  let sawProviderReportedCost = false;
  for (const entry of usage.perModel) {
    sawAnyRow = true;
    if (entry.billedCostUsd !== undefined) {
      summedUsd += entry.billedCostUsd;
      sawProviderReportedCost = true;
    }
    const estimatedInputTokens = entry.estimatedInputTokens ?? entry.inputTokens;
    const estimatedOutputTokens = entry.estimatedOutputTokens ?? entry.outputTokens;
    if (estimatedInputTokens + estimatedOutputTokens > 0) {
      sawEstimatedUsage = true;
      const entryCost = computeCost(
        buildTokenUsageCounts(
          estimatedInputTokens,
          estimatedOutputTokens,
          entry.estimatedCacheReadTokens,
          entry.estimatedCacheCreationTokens
        ),
        resolvePricing(entry.provider, entry.model)
      );
      if (!entryCost.available) {
        // Any unpriced estimated portion makes the whole-thread cost honestly unavailable.
        return { cost: { available: false, reason: 'unpriced_model' }, totalTokens };
      }
      summedUsd += entryCost.usdAmount;
    }
  }

  if (!(sawAnyRow && (sawEstimatedUsage || sawProviderReportedCost))) {
    // A non-null usage with no per-model rows should not happen (the repo
    // returns null for an empty thread), but treat it as unpriced rather than
    // fabricating a $0.
    return { cost: { available: false, reason: 'unpriced_model' }, totalTokens };
  }

  return {
    cost: {
      available: true,
      provenance: sawEstimatedUsage ? 'captured-usage-estimate' : 'provider-reported',
      usdAmount: Math.round(summedUsd * 1_000_000_000_000) / 1_000_000_000_000,
    },
    totalTokens,
  };
}
