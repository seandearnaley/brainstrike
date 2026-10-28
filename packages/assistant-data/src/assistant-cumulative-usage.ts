import {
  ASSISTANT_RUN_USAGE_KINDS,
  type AssistantRunUsageKind,
} from '@brainstrike/assistant-contract/run-usage';
import type { CostEstimate } from '@brainstrike/tokenization';
import type { ThreadCumulativeUsage } from './assistant-memory-repository.ts';

/** One model's usage and cost within a source. */
export interface CumulativeModelUsage {
  /** What its calls cost; null when any of them is unpriced. */
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
}

/** One source's share of the thread total (BST-953). OM rows are local estimates. */
export interface CumulativeSourceUsage {
  /** What its calls cost; null when any of them is unpriced. */
  readonly costUsd: number | null;
  readonly estimated: boolean;
  readonly inputTokens: number;
  readonly kind: AssistantRunUsageKind;
  /** Its models, costliest first. */
  readonly models: readonly CumulativeModelUsage[];
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

type PerModelEntry = ThreadCumulativeUsage['perModel'][number];

/** A subtotal's cost: billed plus estimated; null when its estimated part is unpriced. */
function entryCost(entry: PerModelEntry): number | null {
  const estimatedTokens =
    (entry.estimatedInputTokens ?? entry.inputTokens) +
    (entry.estimatedOutputTokens ?? entry.outputTokens);
  if (estimatedTokens > 0 && entry.estimatedCostUsd === null) {
    return null;
  }
  return (entry.billedCostUsd ?? 0) + (estimatedTokens > 0 ? (entry.estimatedCostUsd ?? 0) : 0);
}

function addCost(total: number | null, cost: number | null): number | null {
  return total === null || cost === null ? null : total + cost;
}

function addModelUsage(
  total: CumulativeModelUsage | undefined,
  entry: PerModelEntry
): CumulativeModelUsage {
  return {
    costUsd: addCost(total?.costUsd ?? 0, entryCost(entry)),
    inputTokens: (total?.inputTokens ?? 0) + entry.inputTokens,
    model: entry.model,
    outputTokens: (total?.outputTokens ?? 0) + entry.outputTokens,
    provider: entry.provider,
  };
}

const costRank = (usage: { readonly costUsd: number | null }): number => usage.costUsd ?? -1;

function resolveBySource(usage: ThreadCumulativeUsage): CumulativeSourceUsage[] {
  const byKind = new Map<AssistantRunUsageKind, Map<string, CumulativeModelUsage>>();
  for (const entry of usage.perModel) {
    const models = byKind.get(entry.runKind) ?? new Map<string, CumulativeModelUsage>();
    const key = `${entry.provider}::${entry.model}`;
    models.set(key, addModelUsage(models.get(key), entry));
    byKind.set(entry.runKind, models);
  }
  const sources: CumulativeSourceUsage[] = [];
  for (const kind of ASSISTANT_RUN_USAGE_KINDS) {
    const models = [...(byKind.get(kind)?.values() ?? [])].sort(
      (left, right) => costRank(right) - costRank(left)
    );
    const inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
    const outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
    if (inputTokens + outputTokens === 0) {
      continue;
    }
    sources.push({
      costUsd: models.reduce<number | null>((sum, model) => addCost(sum, model.costUsd), 0),
      // OM cycle sizes are Mastra's local tokenx estimates; chat/subagent rows
      // are provider-reported aggregates.
      estimated: kind === 'om-observation' || kind === 'om-reflection',
      inputTokens,
      kind,
      models,
      outputTokens,
    });
  }
  return sources;
}

/**
 * Net caching savings across the thread, as the ledger priced each call.
 * Undefined when no cache traffic exists or any cache-bearing call lacks the
 * needed rates (a partial figure would silently under/over-state the savings).
 */
function resolveCacheSavings(usage: ThreadCumulativeUsage): { usdAmount: number } | undefined {
  let sawCacheTraffic = false;
  let savedUsd = 0;
  for (const entry of usage.perModel) {
    if (entry.cacheReadTokens + entry.cacheCreationTokens === 0) {
      continue;
    }
    sawCacheTraffic = true;
    if (entry.cacheSavingsUsd === undefined || entry.cacheSavingsUsd === null) {
      return;
    }
    savedUsd += entry.cacheSavingsUsd;
  }
  return sawCacheTraffic ? { usdAmount: roundUsd(savedUsd) } : undefined;
}

/**
 * Aggregate captured durable usage into the thread-total display value.
 *
 * Cost is summed ACROSS entries, each already priced call by call at its own
 * request's tier. A thread that mixed a priced and an unpriced model is
 * reported as `unpriced_model` overall — partial cost would be a silent
 * under-count, which the no-silent-fallbacks rule forbids.
 */
export function resolveCumulativeUsageDisplay(
  usage: ThreadCumulativeUsage | null
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
      if (entry.estimatedCostUsd === null) {
        // Any unpriced estimated portion makes the whole-thread cost honestly
        // unavailable (cache totals and the by-source split stay useful).
        unpriced = true;
        continue;
      }
      summedUsd += entry.estimatedCostUsd;
    }
  }

  const cacheSavings = unpriced ? undefined : resolveCacheSavings(usage);
  const base = {
    bySource: resolveBySource(usage),
    cacheCreationTokens,
    cacheReadTokens,
    ...(cacheSavings ? { cacheSavings } : {}),
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
