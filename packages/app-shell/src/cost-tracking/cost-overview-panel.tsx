import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import { useAssistantThreadHostLedger } from '../assistant-thread-host-context';
import type { LedgerTrendPoint, LedgerUsageTotals } from '../run-ledger-analytics';
import { formatEstimatedCost, formatTokensCompact, formatUsd, shareWidth } from './cost-format';
import { useLedgerAnalytics } from './use-ledger-analytics';

/** The daily chart shows the most recent days with runs. */
const TREND_DAYS = 14;

/** One token class in the usage mix, drawn in its chart token. */
interface TokenClass {
  readonly color: string;
  readonly count: number;
  readonly label: string;
}

const chartColor = (index: number): string => `hsl(var(--chart-${index}))`;

function tokenClasses(totals: LedgerUsageTotals): TokenClass[] {
  return [
    {
      color: chartColor(1),
      count: totals.inputTokens - totals.cacheReadTokens - totals.cacheWriteTokens,
      label: 'Input',
    },
    { color: chartColor(2), count: totals.cacheReadTokens, label: 'Cache read' },
    { color: chartColor(3), count: totals.cacheWriteTokens, label: 'Cache write' },
    { color: chartColor(5), count: totals.outputTokens, label: 'Output' },
  ];
}

function Stat({
  detail,
  label,
  testId,
  value,
}: {
  readonly detail: string;
  readonly label: string;
  readonly testId: string;
  readonly value: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background/60 px-3 py-2.5" data-testid={testId}>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-0.5 truncate font-semibold text-lg tabular-nums tracking-tight">{value}</p>
      <p className="truncate text-muted-foreground text-xs">{detail}</p>
    </div>
  );
}

/** Input, cache and output tokens as one stacked bar with a legend. */
function TokenMix({ totals }: { readonly totals: LedgerUsageTotals }) {
  const classes = tokenClasses(totals);
  const total = totals.inputTokens + totals.outputTokens;
  return (
    <div className="space-y-2" data-testid="cost-overview-token-mix">
      <div
        aria-label={classes
          .map((tokenClass) => `${tokenClass.label} ${formatTokensCompact(tokenClass.count)}`)
          .join(', ')}
        className="flex h-2.5 overflow-hidden rounded-full bg-muted"
        role="img"
      >
        {classes.map((tokenClass) =>
          tokenClass.count > 0 ? (
            <div
              key={tokenClass.label}
              style={{
                backgroundColor: tokenClass.color,
                width: shareWidth(tokenClass.count, total),
              }}
            />
          ) : null
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {classes.map((tokenClass) => (
          <li className="flex items-center gap-1.5" key={tokenClass.label}>
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ backgroundColor: tokenClass.color }}
            />
            <span className="text-muted-foreground">{tokenClass.label}</span>
            <span className="font-medium tabular-nums">
              {formatTokensCompact(tokenClass.count)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function dayTitle(point: LedgerTrendPoint): string {
  const runs = `${point.runCount} run${point.runCount === 1 ? '' : 's'}`;
  const tokens = `${formatTokensCompact(point.inputTokens + point.outputTokens)} tokens`;
  const unpriced = point.unpricedRunCount > 0 ? `, ${point.unpricedRunCount} unpriced` : '';
  return `${point.label}: ${formatUsd(point.costUsd)} across ${runs}, ${tokens}${unpriced}`;
}

/** Estimated spend per day with runs, newest on the right. */
function DailySpend({ trend }: { readonly trend: readonly LedgerTrendPoint[] }) {
  const days = trend.slice(-TREND_DAYS);
  const peak = Math.max(...days.map((point) => point.costUsd), 0);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-medium text-sm">Daily spend</h4>
        <p className="text-muted-foreground text-xs tabular-nums">Peak {formatUsd(peak)} a day</p>
      </div>
      <ol
        aria-label="Estimated spend per day"
        className="flex h-28 items-end gap-1.5 border-b pb-px"
        data-testid="task-ledger-trend"
      >
        {days.map((point) => (
          <li
            aria-label={dayTitle(point)}
            className="group flex h-full min-w-0 flex-1 flex-col justify-end"
            data-testid="task-ledger-trend-bar"
            key={point.day}
            title={dayTitle(point)}
          >
            <div
              className="min-h-0.5 w-full rounded-t-sm opacity-80 transition-opacity group-hover:opacity-100"
              style={{
                backgroundColor: chartColor(1),
                height: peak > 0 ? `${(point.costUsd / peak) * 100}%` : '2px',
              }}
            />
          </li>
        ))}
      </ol>
      <ol aria-hidden="true" className="flex gap-1.5 text-[11px] text-muted-foreground">
        {days.map((point) => (
          <li className="min-w-0 flex-1 truncate text-center" key={point.day}>
            {point.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

interface CostOverviewPanelViewProps {
  readonly available: boolean;
  readonly totals: LedgerUsageTotals;
  readonly trend: readonly LedgerTrendPoint[];
}

/** The headline: what the recorded runs cost, which tokens they spent, and when. */
export function CostOverviewPanelView({ available, totals, trend }: CostOverviewPanelViewProps) {
  const cachedShare =
    totals.inputTokens > 0 ? Math.round((totals.cacheReadTokens / totals.inputTokens) * 100) : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Spend</CardTitle>
        <CardDescription>
          Estimated from each model's current list prices, with every request priced at its own
          rate, cached tokens included.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6" data-testid="cost-overview">
        {available && totals.runCount > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                detail={
                  totals.unpricedRunCount > 0
                    ? `${totals.unpricedRunCount} unpriced run${totals.unpricedRunCount === 1 ? '' : 's'} left out`
                    : `${totals.runCount} run${totals.runCount === 1 ? '' : 's'}`
                }
                label="Total"
                testId="cost-overview-total"
                value={formatEstimatedCost(totals.costUsd, totals.unpricedRunCount)}
              />
              <Stat
                detail="estimated, per run"
                label="Average"
                testId="cost-overview-average"
                value={formatUsd(
                  totals.costUsd / Math.max(1, totals.runCount - totals.unpricedRunCount)
                )}
              />
              <Stat
                detail={`${cachedShare}% read from cache`}
                label="Input tokens"
                testId="cost-overview-input"
                value={formatTokensCompact(totals.inputTokens)}
              />
              <Stat
                detail="including reasoning"
                label="Output tokens"
                testId="cost-overview-output"
                value={formatTokensCompact(totals.outputTokens)}
              />
            </div>
            <TokenMix totals={totals} />
            {trend.length > 0 ? <DailySpend trend={trend} /> : null}
          </>
        ) : (
          <p className="text-muted-foreground text-sm" data-testid="cost-overview-empty">
            {available
              ? 'No assistant runs recorded yet. Run an assistant turn to start tracking spend.'
              : 'Spend is recorded for desktop assistant runs.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Live spend overview over the host's committed runs. */
export function CostOverviewPanel() {
  const { runs } = useAssistantThreadHostLedger();
  const { totals, trend } = useLedgerAnalytics(runs);
  return (
    <CostOverviewPanelView
      available={hasDurableAssistantUsageCapability()}
      totals={totals}
      trend={trend}
    />
  );
}
