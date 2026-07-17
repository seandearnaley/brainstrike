import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import { formatTokenCount, formatUsdCost } from '@brainstrike/utils/token-counting-heuristics';
import { Coins, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { type CrossRootCostRow, resolveCrossRootCostRows } from '../assistant-cross-root-cost';
import { resolveModelPricing } from './model-pricing';
import { type CrossRootCostState, useCrossRootCost } from './use-cross-root-cost';

function costLabel(row: CrossRootCostRow): string {
  // No silent $0: an unavailable price is its own state, distinct from "free".
  if (!row.cost.available) {
    return 'cost unavailable';
  }
  const amount = formatUsdCost(row.cost.usdAmount);
  return row.cost.provenance === 'captured-usage-estimate'
    ? `captured usage est. ${amount}`
    : amount;
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

  // Display names come from the aggregation's roots JOIN (on each row); the
  // helper reads them directly, so no separate resolver is threaded here.
  const costRows = useMemo(() => resolveCrossRootCostRows(rows, resolveModelPricing), [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4" />
          Cost by Workspace Root
        </CardTitle>
        <CardDescription>
          Captured durable token usage, grouped by workspace root and priced against current model
          list prices. Estimates exclude usage not yet itemized here, including subagents,
          observational memory, embeddings, and some paused or resumed legs.
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
