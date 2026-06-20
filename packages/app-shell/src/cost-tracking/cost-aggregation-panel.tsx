import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { listProviderLlmModels } from '@brainstrike/assistant-contract/provider-registry';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import { formatTokenCount, formatUsdCost } from '@brainstrike/utils/token-counting-heuristics';
import { Coins, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import {
  type CrossRootCostRow,
  type ModelPricingResolver,
  type RootNameResolver,
  resolveCrossRootCostRows,
} from '../assistant-cross-root-cost';
import { type CrossRootCostState, useCrossRootCost } from './use-cross-root-cost';

/**
 * Resolve a model's list price from the static provider registry. Returns
 * undefined for unknown providers/models (keyless/local) — `computeCost` then
 * reports `unpriced_model` and the row renders "cost unavailable", never $0.
 */
const resolveModelPricing: ModelPricingResolver = (provider, model) => {
  if (!isSupportedProvider(provider)) {
    return;
  }
  return listProviderLlmModels(provider).find((candidate) => candidate.id === model)?.pricing;
};

function costLabel(row: CrossRootCostRow): string {
  // No silent $0: an unavailable price is its own state, distinct from "free".
  return row.cost.available ? formatUsdCost(row.cost.usdAmount) : 'cost unavailable';
}

interface CostAggregationPanelViewProps {
  readonly state: CrossRootCostState;
}

/**
 * Presentational cost panel — receives the resolved cross-root state so it can
 * be rendered with a stubbed state in tests without a live DB. The web fallback
 * is honest ("session-only", not zeros) and capability-gated on `available`.
 */
export function CostAggregationPanelView({ state }: CostAggregationPanelViewProps) {
  const { available, error, loading, rows } = state;

  const rootNameByRootId = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.rootId !== null && row.rootDisplayName) {
        map.set(row.rootId, row.rootDisplayName);
      }
    }
    return map;
  }, [rows]);

  const resolveRootName = useMemo<RootNameResolver>(
    () => (rootId: string) => rootNameByRootId.get(rootId),
    [rootNameByRootId]
  );

  const costRows = useMemo(
    () => resolveCrossRootCostRows(rows, resolveModelPricing, resolveRootName),
    [resolveRootName, rows]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4" />
          Cost by Workspace Root
        </CardTitle>
        <CardDescription>
          Durable token usage and estimated cost, grouped by the workspace root each assistant turn
          ran in. Cost is priced per model against current list prices and is an estimate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4" data-testid="cost-aggregation-panel">
        {available ? (
          <CostAggregationRows
            costRows={costRows}
            error={error}
            hasRows={rows.length > 0}
            loading={loading}
          />
        ) : (
          <p className="text-muted-foreground text-sm" data-testid="cost-aggregation-session-only">
            Cross-root cost tracking is persisted on desktop only. On the web app, usage is
            session-only and is not stored across reloads.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface CostAggregationRowsProps {
  readonly costRows: readonly CrossRootCostRow[];
  readonly error: Error | null;
  readonly hasRows: boolean;
  readonly loading: boolean;
}

function CostAggregationRows({ costRows, error, hasRows, loading }: CostAggregationRowsProps) {
  if (error) {
    return (
      <p className="text-destructive text-sm" data-testid="cost-aggregation-error">
        Failed to load cross-root cost: {error.message}
      </p>
    );
  }
  if (loading && !hasRows) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-3.5 animate-spin" />
        Loading cost data…
      </p>
    );
  }
  if (costRows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="cost-aggregation-empty">
        No durable token usage recorded yet. Run an assistant turn to start tracking cost.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {costRows.map((row) => (
        <li
          className="flex items-center justify-between gap-4 rounded-md border p-3"
          data-testid="cost-aggregation-row"
          key={row.rootId ?? '__unattributed__'}
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-sm" title={row.displayName}>
              {row.displayName}
            </p>
            <p className="text-muted-foreground text-xs">{formatTokenCount(row.totalTokens)}</p>
          </div>
          <Badge
            data-testid="cost-aggregation-cost"
            variant={row.cost.available ? 'secondary' : 'outline'}
          >
            {costLabel(row)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Live cost panel — wires the reactive cross-root usage query to the view. */
export function CostAggregationPanel() {
  const state = useCrossRootCost();
  return <CostAggregationPanelView state={state} />;
}
