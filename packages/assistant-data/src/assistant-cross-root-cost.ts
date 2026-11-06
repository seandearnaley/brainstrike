import type { CostEstimate, ModelTokenPricing } from '@brainstrike/tokenization';
import type { CrossRootUsageRow } from './assistant-memory-repository.ts';

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
  /** The branch its runs had checked out, when one was recorded. */
  readonly branch: string | null;
  readonly cost: CostEstimate;
  readonly displayName: string;
  readonly inputTokens: number;
  /** The repository a worktree root belongs to; null outside a worktree. */
  readonly localRootId: string | null;
  readonly outputTokens: number;
  readonly rootId: string | null;
  readonly totalTokens: number;
}

/** Resolves a model's pricing from the registry (undefined when unknown). */
export type ModelPricingResolver = (
  provider: string,
  model: string
) => ModelTokenPricing | undefined;

interface RootAggregate {
  branch: string | null;
  cost: number;
  displayName: string;
  hasUnpriced: boolean;
  inputTokens: number;
  localRootId: string | null;
  outputTokens: number;
  rootId: string | null;
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
 * Each row's cost was priced call by call under its own model, then is summed
 * within each root. A root that mixed a priced and an unpriced model is
 * reported as `unpriced_model` for that root — partial cost would be a silent
 * under-count, which the no-silent-fallbacks rule forbids. Roots preserve the
 * input order (the repo already sorts NULLS FIRST, then by id).
 */
export function resolveCrossRootCostRows(rows: readonly CrossRootUsageRow[]): CrossRootCostRow[] {
  const order: Array<string | null> = [];
  const byRoot = new Map<string | null, RootAggregate>();

  for (const row of rows) {
    const key = row.rootId;
    let aggregate = byRoot.get(key);
    if (!aggregate) {
      aggregate = {
        branch: null,
        cost: 0,
        displayName: resolveDisplayName(row),
        hasUnpriced: false,
        inputTokens: 0,
        localRootId: row.localRootId,
        outputTokens: 0,
        rootId: row.rootId,
        sawEstimatedUsage: false,
        sawProviderReportedCost: false,
        totalTokens: 0,
      };
      byRoot.set(key, aggregate);
      order.push(key);
    }
    aggregate.branch ??= row.checkoutBranch;
    aggregate.inputTokens += row.inputTokens;
    aggregate.outputTokens += row.outputTokens;
    aggregate.totalTokens += row.inputTokens + row.outputTokens;
    if (row.billedCostUsd !== undefined) {
      aggregate.cost += row.billedCostUsd;
      aggregate.sawProviderReportedCost = true;
    }
    const estimatedInputTokens = row.estimatedInputTokens ?? row.inputTokens;
    const estimatedOutputTokens = row.estimatedOutputTokens ?? row.outputTokens;
    if (estimatedInputTokens + estimatedOutputTokens > 0) {
      aggregate.sawEstimatedUsage = true;
      if (row.estimatedCostUsd === null) {
        aggregate.hasUnpriced = true;
      } else {
        aggregate.cost += row.estimatedCostUsd;
      }
    }
  }

  return order.map((key) => {
    const aggregate = byRoot.get(key);
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
      branch: aggregate.branch,
      cost,
      displayName: aggregate.displayName,
      inputTokens: aggregate.inputTokens,
      localRootId: aggregate.localRootId,
      outputTokens: aggregate.outputTokens,
      rootId: aggregate.rootId,
      totalTokens: aggregate.totalTokens,
    };
  });
}
