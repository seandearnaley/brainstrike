import { type CrossRootCostRow, resolveCrossRootCostRows } from '@brainstrike/assistant-data';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
} from '@brainstrike/ui';
import { GitBranch, Loader2 } from 'lucide-react';

import { useAssistantThreadHostLedger } from '../assistant-thread-host-context';
import { formatTokensCompact, formatUsd, shareWidth } from './cost-format';
import { type CrossRootCostState, useCrossRootCost } from './use-cross-root-cost';

function costLabel(row: CrossRootCostRow): string {
  // No silent $0: an unavailable price is its own state, distinct from "free".
  return row.cost.available ? formatUsd(row.cost.usdAmount) : 'cost unavailable';
}

function costOf(row: CrossRootCostRow): number {
  return row.cost.available ? row.cost.usdAmount : 0;
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
  const costRows = resolveCrossRootCostRows(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost by workspace</CardTitle>
        <CardDescription>
          Every recorded model call, memory and subagents included, grouped by the folder its thread
          worked in. A worktree is named after its repository and branch.
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
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
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
  const sorted = [...costRows].sort((left, right) => costOf(right) - costOf(left));
  const total = sorted.reduce((sum, row) => sum + costOf(row), 0);
  return (
    <ul className="divide-y rounded-md border">
      {sorted.map((row) => (
        <li
          className="space-y-2 px-3 py-2.5"
          data-testid="cost-aggregation-row"
          key={row.rootId ?? '__unattributed__'}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium" title={row.displayName}>
                  {row.displayName}
                </span>
                {row.localRootId === null ? null : (
                  <Badge className="shrink-0 font-normal" variant="outline">
                    worktree
                  </Badge>
                )}
              </div>
              {row.branch ? (
                <p
                  className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs"
                  data-testid="cost-aggregation-branch"
                >
                  <GitBranch aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate font-mono" title={row.branch}>
                    {row.branch}
                  </span>
                </p>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <p
                className={cn(
                  'text-sm font-semibold tabular-nums',
                  !row.cost.available && 'text-muted-foreground font-normal'
                )}
                data-testid="cost-aggregation-cost"
              >
                {costLabel(row)}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {formatTokensCompact(row.inputTokens)} in · {formatTokensCompact(row.outputTokens)}{' '}
                out
              </p>
            </div>
          </div>
          <div aria-hidden="true" className="bg-muted h-1 overflow-hidden rounded-full">
            <div
              className="bg-primary/70 h-full rounded-full"
              style={{ width: shareWidth(costOf(row), total) }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Live cost panel — wires the reactive cross-root usage query to the view. */
export function CostAggregationPanel() {
  // Agent-host threads' committed provider calls count beside the usage rows.
  const { rootUsage } = useAssistantThreadHostLedger();
  const state = useCrossRootCost(rootUsage);
  return <CostAggregationPanelView state={state} />;
}
