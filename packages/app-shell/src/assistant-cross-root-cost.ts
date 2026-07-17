import {
  type CostEstimate,
  computeCost,
  type ModelTokenPricing,
} from '@brainstrike/utils/token-counting-heuristics';
import type { CrossRootUsageRow } from './assistant-memory-repository';

/** Label for the bucket of usage that had no focused root at request start. */
export const UNATTRIBUTED_ROOT_LABEL = 'Unattributed';

/**
 * One workspace ROOT's resolved cost view for the cost-tracking panel. `cost`
 * is a discriminated CostEstimate (never $0 for an unavailable price — see the
 * no-silent-fallbacks rule). `displayName` is the root's human name when known,
 * "Unattributed" for the null-root bucket, or a short id fallback when the
 * roots lookup misses (honest — never a wrong name).
 */
export interface CrossRootCostRow {
  readonly cost: CostEstimate;
  readonly displayName: string;
  readonly rootId: string | null;
  readonly totalTokens: number;
}

/** Resolves a model's pricing from the registry (undefined when unknown / keyless). */
export type ModelPricingResolver = (
  provider: string,
  model: string
) => ModelTokenPricing | undefined;

interface RootAggregate {
  cost: number;
  displayName: string;
  hasUnpriced: boolean;
  sawEstimatedUsage: boolean;
  sawProviderReportedCost: boolean;
  totalTokens: number;
}

function shortenRootId(rootId: string): string {
  // The roots join missed (e.g. a legacy path-remapped id). Show a short,
  // recognizable slice rather than a wrong name or a fabricated bucket.
  return rootId.length > 12 ? `${rootId.slice(0, 8)}…` : rootId;
}

function resolveDisplayName(row: CrossRootUsageRow): string {
  if (row.rootId === null) {
    return UNATTRIBUTED_ROOT_LABEL;
  }
  // Prefer the display name the aggregation JOINed from the roots table; fall
  // back to a short id when the join missed (never a wrong/fabricated name).
  return row.rootDisplayName ?? shortenRootId(row.rootId);
}

/**
 * Aggregate captured durable per-(root, model) usage into per-root cost rows.
 *
 * Cost is priced PER MODEL with that model's own registry rate, then summed
 * within each root. A root that mixed a priced and an unpriced model is
 * reported as `unpriced_model` for that root — partial cost would be a silent
 * under-count, which the no-silent-fallbacks rule forbids. Roots preserve the
 * input order (the repo already sorts NULLS FIRST, then by id).
 */
export function resolveCrossRootCostRows(
  rows: readonly CrossRootUsageRow[],
  resolvePricing: ModelPricingResolver
): CrossRootCostRow[] {
  const order: Array<string | null> = [];
  const byRoot = new Map<string | null, RootAggregate>();

  for (const row of rows) {
    let aggregate = byRoot.get(row.rootId);
    if (!aggregate) {
      aggregate = {
        cost: 0,
        displayName: resolveDisplayName(row),
        hasUnpriced: false,
        sawEstimatedUsage: false,
        sawProviderReportedCost: false,
        totalTokens: 0,
      };
      byRoot.set(row.rootId, aggregate);
      order.push(row.rootId);
    }
    aggregate.totalTokens += row.inputTokens + row.outputTokens;
    if (row.billedCostUsd !== undefined) {
      aggregate.cost += row.billedCostUsd;
      aggregate.sawProviderReportedCost = true;
    }
    const estimatedInputTokens = row.estimatedInputTokens ?? row.inputTokens;
    const estimatedOutputTokens = row.estimatedOutputTokens ?? row.outputTokens;
    if (estimatedInputTokens + estimatedOutputTokens > 0) {
      aggregate.sawEstimatedUsage = true;
      const entryCost = computeCost(
        { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens },
        resolvePricing(row.provider, row.model)
      );
      if (entryCost.available) {
        aggregate.cost += entryCost.usdAmount;
      } else {
        aggregate.hasUnpriced = true;
      }
    }
  }

  return order.map((rootId) => {
    const aggregate = byRoot.get(rootId);
    if (!aggregate) {
      // Unreachable: every key in `order` was set above. Keep typing honest.
      throw new Error('Cross-root cost aggregation lost a root key.');
    }
    const cost: CostEstimate =
      aggregate.hasUnpriced || !(aggregate.sawEstimatedUsage || aggregate.sawProviderReportedCost)
        ? { available: false, reason: 'unpriced_model' }
        : {
            available: true,
            provenance: aggregate.sawEstimatedUsage
              ? 'captured-usage-estimate'
              : 'provider-reported',
            usdAmount: Math.round(aggregate.cost * 1_000_000_000_000) / 1_000_000_000_000,
          };
    return {
      cost,
      displayName: aggregate.displayName,
      rootId,
      totalTokens: aggregate.totalTokens,
    };
  });
}
