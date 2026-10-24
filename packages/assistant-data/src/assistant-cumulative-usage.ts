import {
  ASSISTANT_RUN_USAGE_KINDS,
  type AssistantRunUsageKind,
} from '@brainstrike/assistant-contract/run-usage';
import {
  buildTokenUsageCounts,
  type CostEstimate,
  computeCost,
  type ModelTokenPricing,
} from '@brainstrike/tokenization';
import type { ThreadCumulativeUsage } from './assistant-memory-repository.ts';

/** One source's share of the thread total (BST-953). OM rows are local estimates. */
export interface CumulativeSourceUsage {
  readonly estimated: boolean;
  readonly inputTokens: number;
  readonly kind: AssistantRunUsageKind;
  readonly outputTokens: number;
}

/**
 * Resolved thread-total usage view for the context meter (BST-953): every
 * durable captured row — chat turns, subagent delegations, OM observer/
 * reflector cycles — with in/out and cache-class totals. Still not itemized:
 * embeddings and some paused/resumed legs. `cost` therefore carries captured-
 * usage estimate provenance, never an unqualified exact-total claim, and OM
 * token figures are Mastra's local estimates (flagged per source).
 */
export interface CumulativeUsageDisplay {
  /** Non-zero per-source subtotals in stable kind order. */
  readonly bySource: readonly CumulativeSourceUsage[];
  /** Prompt-cache write tokens across the whole thread (share of `inputTokens`). */
  readonly cacheCreationTokens: number;
  /** Prompt-cache read tokens across the whole thread (share of `inputTokens`). */
  readonly cacheReadTokens: number;
  /**
   * Net USD kept by prompt caching: read-token discount minus write-token
   * premium, priced per model from the registry. ABSENT when there is no cache
   * traffic or any cache-bearing model lacks the needed rates — never a guess.
   */
  readonly cacheSavings?: { readonly usdAmount: number };
  readonly cost: CostEstimate;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Resolves a model's pricing from the registry (undefined when unknown / keyless). */
export type ModelPricingResolver = (
  provider: string,
  model: string
) => ModelTokenPricing | undefined;

/**
 * Honest ZERO baseline for a repo-backed thread with no captured rows yet
 * (review fix, BST-953): nothing has been spent, so the captured-usage
 * estimate is genuinely $0.00 — and a PRESENT cumulative value lets the meter
 * render the first run's live step usage as the thread-total headline instead
 * of discarding it. Never used for a failed load (that stays null: "couldn't
 * read" must not display as $0.00) or on web (capability-absent).
 */
export const EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY: CumulativeUsageDisplay = {
  bySource: [],
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  cost: { available: true, provenance: 'captured-usage-estimate', usdAmount: 0 },
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const USD_ROUNDING = 1_000_000_000_000;

function roundUsd(amount: number): number {
  return Math.round(amount * USD_ROUNDING) / USD_ROUNDING;
}

function resolveBySource(usage: ThreadCumulativeUsage): CumulativeSourceUsage[] {
  const byKind = new Map<AssistantRunUsageKind, { inputTokens: number; outputTokens: number }>();
  for (const entry of usage.perModel) {
    const bucket = byKind.get(entry.runKind) ?? { inputTokens: 0, outputTokens: 0 };
    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    byKind.set(entry.runKind, bucket);
  }
  const sources: CumulativeSourceUsage[] = [];
  for (const kind of ASSISTANT_RUN_USAGE_KINDS) {
    const bucket = byKind.get(kind);
    if (!bucket || bucket.inputTokens + bucket.outputTokens === 0) {
      continue;
    }
    sources.push({
      // OM cycle sizes are Mastra's local tokenx estimates; chat/subagent rows
      // are provider-reported aggregates.
      estimated: kind === 'om-observation' || kind === 'om-reflection',
      inputTokens: bucket.inputTokens,
      kind,
      outputTokens: bucket.outputTokens,
    });
  }
  return sources;
}

/**
 * Net caching savings across the thread, priced per model. Undefined when no
 * cache traffic exists or any cache-bearing model lacks the needed rates (a
 * partial figure would silently under/over-state the savings).
 */
function resolveCacheSavings(
  usage: ThreadCumulativeUsage,
  resolvePricing: ModelPricingResolver
): { usdAmount: number } | undefined {
  let sawCacheTraffic = false;
  let savedUsd = 0;
  for (const entry of usage.perModel) {
    const cacheTokens = entry.cacheReadTokens + entry.cacheCreationTokens;
    if (cacheTokens === 0) {
      continue;
    }
    sawCacheTraffic = true;
    const pricing = resolvePricing(entry.provider, entry.model);
    if (!pricing) {
      return;
    }
    if (entry.cacheReadTokens > 0) {
      if (pricing.cacheReadPerMTok === undefined) {
        return;
      }
      savedUsd += (entry.cacheReadTokens * (pricing.inputPerMTok - pricing.cacheReadPerMTok)) / 1e6;
    }
    if (entry.cacheCreationTokens > 0) {
      if (pricing.cacheWritePerMTok === undefined) {
        return;
      }
      savedUsd -=
        (entry.cacheCreationTokens * (pricing.cacheWritePerMTok - pricing.inputPerMTok)) / 1e6;
    }
  }
  return sawCacheTraffic ? { usdAmount: roundUsd(savedUsd) } : undefined;
}

/**
 * Aggregate captured durable usage into the thread-total display value.
 *
 * Cost is summed ACROSS entries: each per-(model, kind) subtotal is priced
 * with that model's own registry rate, then totalled. A thread that mixed a
 * priced and an unpriced model is reported as `unpriced_model` overall —
 * partial cost would be a silent under-count, which the no-silent-fallbacks
 * rule forbids.
 */
export function resolveCumulativeUsageDisplay(
  usage: ThreadCumulativeUsage | null,
  resolvePricing: ModelPricingResolver
): CumulativeUsageDisplay | null {
  if (!usage) {
    return null;
  }

  const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  let summedUsd = 0;
  let sawAnyRow = false;
  let sawEstimatedUsage = false;
  let sawProviderReportedCost = false;
  let unpriced = false;
  for (const entry of usage.perModel) {
    sawAnyRow = true;
    cacheReadTokens += entry.cacheReadTokens;
    cacheCreationTokens += entry.cacheCreationTokens;
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
        // Any unpriced estimated portion makes the whole-thread cost honestly
        // unavailable (cache totals and the by-source split stay useful).
        unpriced = true;
        continue;
      }
      summedUsd += entryCost.usdAmount;
    }
  }

  const base = {
    bySource: resolveBySource(usage),
    cacheCreationTokens,
    cacheReadTokens,
    ...(unpriced
      ? {}
      : (() => {
          const cacheSavings = resolveCacheSavings(usage, resolvePricing);
          return cacheSavings ? { cacheSavings } : {};
        })()),
    inputTokens: usage.totalInputTokens,
    outputTokens: usage.totalOutputTokens,
    totalTokens,
  };

  if (unpriced || !(sawAnyRow && (sawEstimatedUsage || sawProviderReportedCost))) {
    // A non-null usage with no per-model rows should not happen (the repo
    // returns null for an empty thread), but treat it as unpriced rather than
    // fabricating a $0.
    return { ...base, cost: { available: false, reason: 'unpriced_model' } };
  }

  return {
    ...base,
    cost: {
      available: true,
      provenance: sawEstimatedUsage ? 'captured-usage-estimate' : 'provider-reported',
      usdAmount: roundUsd(summedUsd),
    },
  };
}
