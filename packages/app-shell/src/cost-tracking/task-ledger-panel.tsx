import { useAssistantBudgetPreferencesStore } from '@brainstrike/app-state/stores/assistant-budget-preferences-store';
import type {
  AssistantRunOutcomeVerdict,
  AssistantThreadRunStatus,
  RunLedgerRow,
} from '@brainstrike/assistant-data';
import {
  resolveModelPricing,
  TASK_LEDGER_RUN_LIMIT,
  useRunLedger,
} from '@brainstrike/assistant-data/cost-tracking';
import { buildTokenUsageCounts, computeCost, formatUsdCost } from '@brainstrike/tokenization';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@brainstrike/ui';
import { ListChecks, Loader2, RefreshCw } from 'lucide-react';
import { useCallback } from 'react';
import { useAssistantThreadHostLedger } from '../assistant-thread-host-context';
import type { LedgerModelComparisonRow, LedgerTrendPoint } from '../run-ledger-analytics';
import { useLedgerAnalytics } from './use-ledger-analytics';

/** Run-table slice of the view state (structural subset of RunLedgerState). */
export interface TaskLedgerRunsViewState {
  readonly available: boolean;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly rows: readonly RunLedgerRow[];
}

/** Analytics slice of the view state (LedgerAnalyticsState). */
export interface TaskLedgerAnalyticsViewState {
  readonly models: readonly LedgerModelComparisonRow[];
  readonly trend: readonly LedgerTrendPoint[];
}

interface TaskLedgerPanelViewProps {
  readonly analytics: TaskLedgerAnalyticsViewState;
  readonly ledger: TaskLedgerRunsViewState;
  readonly onRefresh: () => void;
  /** Per-run cost cap in USD (budget guardrails); null/absent = off. */
  readonly perRunCapUsd?: number | null | undefined;
}

const STATUS_BADGE_VARIANTS: Record<
  AssistantThreadRunStatus,
  'destructive' | 'outline' | 'secondary'
> = {
  cancelled: 'outline',
  cancelling: 'outline',
  completed: 'secondary',
  failed: 'destructive',
  running: 'outline',
};

const OUTCOME_BADGE_VARIANTS: Record<
  AssistantRunOutcomeVerdict,
  'destructive' | 'outline' | 'secondary'
> = {
  failed: 'destructive',
  mixed: 'outline',
  succeeded: 'secondary',
};

const startedAtFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
});

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null) {
    return '—';
  }
  if (durationMs < MS_PER_SECOND) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainder = Math.round(seconds % SECONDS_PER_MINUTE);
  return `${minutes}m ${remainder}s`;
}

function formatTokensCompact(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Honest per-run cost label. Exact provider-reported cost renders as-is;
 * a registry-priced remainder is explicitly marked "est."; an unpriced model
 * reads "cost unavailable" and a run with no captured usage reads "no usage
 * recorded" — NEVER a fabricated $0 (same contract as the sibling cost panel).
 */
/**
 * Usage counts for pricing one ledger row. The cache shares are computed from
 * the UNBILLED rows only (same SQL predicate as estimatedInputTokens), so they
 * pair correctly with either the estimated remainder or the whole-row totals
 * (an Anthropic row never carries a provider-reported cost, so its estimated
 * tokens equal its totals).
 */
function usageCountsWithCacheShares(row: RunLedgerRow, inputTokens: number, outputTokens: number) {
  return buildTokenUsageCounts(
    inputTokens,
    outputTokens,
    row.estimatedCacheReadTokens,
    row.estimatedCacheCreationTokens
  );
}

function runCostLabel(row: RunLedgerRow): string {
  if (row.billedCostUsd !== undefined) {
    // Honest partial-cost rule (review #1698): billedCostUsd covers only the
    // provider-reported usage rows. A mixed run's unreported remainder is
    // priced and shown alongside — never silently folded into an "exact" figure.
    const estimatedTokens = row.estimatedInputTokens + row.estimatedOutputTokens;
    if (estimatedTokens === 0) {
      return formatUsdCost(row.billedCostUsd);
    }
    const remainder = computeCost(
      usageCountsWithCacheShares(row, row.estimatedInputTokens, row.estimatedOutputTokens),
      resolveModelPricing(row.provider, row.model)
    );
    return remainder.available
      ? `${formatUsdCost(row.billedCostUsd)} + est. ${formatUsdCost(remainder.usdAmount)}`
      : `${formatUsdCost(row.billedCostUsd)} + unpriced remainder`;
  }
  if (row.inputTokens + row.outputTokens === 0) {
    return 'no usage recorded';
  }
  const estimate = computeCost(
    usageCountsWithCacheShares(row, row.inputTokens, row.outputTokens),
    resolveModelPricing(row.provider, row.model)
  );
  return estimate.available ? `est. ${formatUsdCost(estimate.usdAmount)}` : 'cost unavailable';
}

/**
 * Whether a run's exact-or-priced cost EXCEEDS the per-run cap. Display-only
 * (budget guardrails v1): exact provider-reported cost is authoritative; a
 * registry-priced estimate is used otherwise. Runs with no usage or an
 * unpriced model are NEVER flagged — a fabricated number must not accuse a
 * run of blowing the budget (honest-cost contract).
 */
export function isRunOverCap(row: RunLedgerRow, perRunCapUsd: number): boolean {
  if (row.billedCostUsd !== undefined) {
    // Include the priced unreported remainder (mixed runs); an unpriced
    // remainder is never fabricated, so only the exact portion is compared.
    const remainder =
      row.estimatedInputTokens + row.estimatedOutputTokens > 0
        ? computeCost(
            usageCountsWithCacheShares(row, row.estimatedInputTokens, row.estimatedOutputTokens),
            resolveModelPricing(row.provider, row.model)
          )
        : null;
    const total =
      remainder?.available === true ? row.billedCostUsd + remainder.usdAmount : row.billedCostUsd;
    return total > perRunCapUsd;
  }
  if (row.inputTokens + row.outputTokens === 0) {
    return false;
  }
  const estimate = computeCost(
    usageCountsWithCacheShares(row, row.inputTokens, row.outputTokens),
    resolveModelPricing(row.provider, row.model)
  );
  return estimate.available && estimate.usdAmount > perRunCapUsd;
}

function outcomeChipTitle(row: RunLedgerRow): string {
  const source = row.outcomeSource === null ? 'unknown source' : row.outcomeSource;
  return row.outcomeDetail === null
    ? `Labeled by ${source}`
    : `Labeled by ${source}: ${row.outcomeDetail}`;
}

/**
 * Presentational Task Ledger panel — receives resolved states so tests can
 * stub every honest-cost/error/empty permutation without a live DB (same
 * composition as CostAggregationPanelView).
 */
export function TaskLedgerPanelView({
  analytics,
  ledger,
  onRefresh,
  perRunCapUsd,
}: TaskLedgerPanelViewProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="size-4" />
              Task Ledger
            </CardTitle>
            <CardDescription>
              Latest {TASK_LEDGER_RUN_LIMIT} assistant runs with tool, edit, token, cost, and
              outcome signals. Exact cost appears only when the provider reported it; everything
              else is explicitly estimated or marked unavailable.
            </CardDescription>
          </div>
          {ledger.available ? (
            <Button
              data-testid="task-ledger-refresh"
              onClick={onRefresh}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Refresh
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-6" data-testid="task-ledger-panel">
        {ledger.available ? (
          <TaskLedgerSections
            analytics={analytics}
            ledger={ledger}
            onRefresh={onRefresh}
            perRunCapUsd={perRunCapUsd}
          />
        ) : (
          <p className="text-muted-foreground text-sm" data-testid="task-ledger-session-only">
            The Task Ledger is persisted on desktop only. On the web app, assistant runs are
            session-only and are not stored across reloads.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TaskLedgerSections({
  analytics,
  ledger,
  onRefresh,
  perRunCapUsd,
}: TaskLedgerPanelViewProps) {
  const hasAnalyticsData = analytics.models.length > 0 || analytics.trend.length > 0;
  const hasAnyError = ledger.error !== null;
  const hasAnyData = ledger.rows.length > 0 || hasAnalyticsData;

  if (!hasAnyError && ledger.loading && !hasAnyData) {
    return (
      <p
        className="flex items-center gap-2 text-muted-foreground text-sm"
        data-testid="task-ledger-loading"
      >
        <Loader2 className="size-3.5 animate-spin" />
        Loading run ledger…
      </p>
    );
  }
  if (!(hasAnyError || ledger.loading || hasAnyData)) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="task-ledger-empty">
        No assistant runs recorded yet. Run an assistant turn to start the ledger.
      </p>
    );
  }
  return (
    <>
      <TrendSection trend={analytics.trend} />
      <ModelComparisonSection models={analytics.models} />
      {ledger.error ? (
        <LedgerErrorBlock error={ledger.error} onRetry={onRefresh} scope="run ledger" />
      ) : (
        <RunTableSection perRunCapUsd={perRunCapUsd} rows={ledger.rows} />
      )}
    </>
  );
}

function LedgerErrorBlock({
  error,
  onRetry,
  scope,
}: {
  readonly error: Error;
  readonly onRetry: () => void;
  readonly scope: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2" data-testid="task-ledger-error">
      <p className="text-destructive text-sm">
        Failed to load {scope}: {error.message}
      </p>
      <Button
        data-testid="task-ledger-retry"
        onClick={onRetry}
        size="sm"
        type="button"
        variant="outline"
      >
        <RefreshCw aria-hidden="true" className="size-3.5" />
        Retry
      </Button>
    </div>
  );
}

const TREND_VIEWBOX_WIDTH = 100;
const TREND_VIEWBOX_HEIGHT = 40;
const TREND_BAR_MIN_HEIGHT = 2;
const TREND_BAR_WIDTH_RATIO = 0.75;

function trendBarTitle(point: LedgerTrendPoint): string {
  const day = point.label;
  const runs = `${point.runCount} run${point.runCount === 1 ? '' : 's'}`;
  const tokens = `${formatTokensCompact(point.inputTokens + point.outputTokens)} tokens`;
  if (point.billedCostUsd === undefined) {
    // No provider-reported cost for this bucket — say so, never claim $0.
    return `${day} — ${runs}, ${tokens}, no exact cost reported`;
  }
  const estimatedTokens = point.estimatedInputTokens + point.estimatedOutputTokens;
  const estimatedNote =
    estimatedTokens > 0
      ? ` (+${formatTokensCompact(estimatedTokens)} tokens without exact cost)`
      : '';
  return `${day} — ${runs}, ${tokens}, ${formatUsdCost(point.billedCostUsd)} exact${estimatedNote}`;
}

/**
 * Dependency-free daily trend: one SVG bar per non-empty day bucket, scaled by
 * token volume (the only metric present on every bucket). Exact billed cost is
 * carried in each bar's accessible title with explicit provenance.
 */
function TrendSection({ trend }: { readonly trend: readonly LedgerTrendPoint[] }) {
  if (trend.length === 0) {
    return null;
  }
  const maxTokens = Math.max(...trend.map((point) => point.inputTokens + point.outputTokens), 1);
  const slotWidth = TREND_VIEWBOX_WIDTH / trend.length;
  const barWidth = slotWidth * TREND_BAR_WIDTH_RATIO;
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-sm">Daily cost & usage trend</h3>
      <p className="text-muted-foreground text-xs">
        Bar height shows token volume per day; hover a bar for runs and exact billed cost where the
        provider reported it.
      </p>
      <svg
        aria-label="Daily token usage and billed cost trend"
        className="h-16 w-full text-primary"
        data-testid="task-ledger-trend"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${TREND_VIEWBOX_WIDTH} ${TREND_VIEWBOX_HEIGHT}`}
      >
        {trend.map((point, index) => {
          const totalTokens = point.inputTokens + point.outputTokens;
          const barHeight = Math.max(
            TREND_BAR_MIN_HEIGHT,
            (totalTokens / maxTokens) * TREND_VIEWBOX_HEIGHT
          );
          const x = index * slotWidth + (slotWidth - barWidth) / 2;
          return (
            <rect
              data-testid="task-ledger-trend-bar"
              fill="currentColor"
              height={barHeight}
              key={point.day}
              opacity={point.billedCostUsd === undefined ? 0.45 : 0.9}
              width={barWidth}
              x={x}
              y={TREND_VIEWBOX_HEIGHT - barHeight}
            >
              <title>{trendBarTitle(point)}</title>
            </rect>
          );
        })}
      </svg>
    </section>
  );
}

function modelLabelsSummary(row: LedgerModelComparisonRow): string {
  const parts: string[] = [];
  if (row.labeledSucceededCount > 0) {
    parts.push(`${row.labeledSucceededCount} succeeded`);
  }
  if (row.labeledFailedCount > 0) {
    parts.push(`${row.labeledFailedCount} failed`);
  }
  if (row.labeledMixedCount > 0) {
    parts.push(`${row.labeledMixedCount} mixed`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function modelStatusSummary(row: LedgerModelComparisonRow): string {
  const parts = [`${row.completedRunCount} completed`];
  if (row.failedRunCount > 0) {
    parts.push(`${row.failedRunCount} failed`);
  }
  if (row.cancelledRunCount > 0) {
    parts.push(`${row.cancelledRunCount} cancelled`);
  }
  return parts.join(' · ');
}

function ModelComparisonSection({
  models,
}: {
  readonly models: readonly LedgerModelComparisonRow[];
}) {
  if (models.length === 0) {
    return null;
  }
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-sm">Model comparison</h3>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Runs</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Labeled outcomes</TableHead>
              <TableHead>Avg duration</TableHead>
              <TableHead>Exact cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((row) => {
              const estimatedTokens = row.estimatedInputTokens + row.estimatedOutputTokens;
              return (
                <TableRow data-testid="task-ledger-model-row" key={`${row.provider}:${row.model}`}>
                  <TableCell>
                    <span className="font-medium">{row.model}</span>{' '}
                    <span className="text-muted-foreground text-xs">{row.provider}</span>
                  </TableCell>
                  <TableCell>{row.runCount}</TableCell>
                  <TableCell>{modelStatusSummary(row)}</TableCell>
                  <TableCell>{modelLabelsSummary(row)}</TableCell>
                  <TableCell>{formatDurationMs(row.avgDurationMs)}</TableCell>
                  <TableCell>
                    {row.billedCostUsd === undefined ? '—' : formatUsdCost(row.billedCostUsd)}
                    {estimatedTokens > 0 ? (
                      <span className="text-muted-foreground text-xs">
                        {' '}
                        +{formatTokensCompact(estimatedTokens)} est. tokens
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function RunTableSection({
  perRunCapUsd,
  rows,
}: {
  readonly perRunCapUsd?: number | null | undefined;
  readonly rows: readonly RunLedgerRow[];
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-sm">Latest runs</h3>
      <div className="overflow-x-auto">
        {/* Floor width so narrow dialogs scroll horizontally instead of
            compressing columns until cost/outcome text clips. */}
        <Table className="min-w-[56rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Tools</TableHead>
              <TableHead>Edits</TableHead>
              <TableHead>Tokens</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow data-testid="task-ledger-run-row" key={row.runId}>
                <TableCell className="whitespace-nowrap">
                  {startedAtFormatter.format(row.startedAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="font-medium">{row.model}</span>{' '}
                  <span className="text-muted-foreground text-xs">{row.provider}</span>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE_VARIANTS[row.status]}>{row.status}</Badge>
                </TableCell>
                <TableCell>{formatDurationMs(row.durationMs)}</TableCell>
                <TableCell>
                  {row.toolCallCount}
                  {row.failedToolCallCount > 0 ? (
                    <Badge
                      className="ml-1"
                      data-testid="task-ledger-failed-tools"
                      variant="destructive"
                    >
                      {row.failedToolCallCount} failed
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell data-testid="task-ledger-edits">
                  {row.editCount ?? '—'}
                  {row.revertedEditCount !== undefined && row.revertedEditCount > 0 ? (
                    <Badge
                      className="ml-1"
                      data-testid="task-ledger-reverted-edits"
                      variant="outline"
                    >
                      {row.revertedEditCount} reverted
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatTokensCompact(row.inputTokens)} in /{' '}
                  {formatTokensCompact(row.outputTokens)} out
                </TableCell>
                <TableCell className="whitespace-nowrap" data-testid="task-ledger-run-cost">
                  {runCostLabel(row)}
                  {typeof perRunCapUsd === 'number' && isRunOverCap(row, perRunCapUsd) ? (
                    <Badge
                      className="ml-1"
                      data-testid="task-ledger-over-cap"
                      title={`This run's cost exceeds the per-run cap of ${formatUsdCost(perRunCapUsd)}.`}
                      variant="destructive"
                    >
                      over cap
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  {row.outcomeVerdict === null ? null : (
                    <Badge
                      data-testid="task-ledger-outcome"
                      title={outcomeChipTitle(row)}
                      variant={OUTCOME_BADGE_VARIANTS[row.outcomeVerdict]}
                    >
                      {row.outcomeVerdict}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** Live Task Ledger panel — wires the reactive run query + analytics fetch to the view. */
export function TaskLedgerPanel() {
  // Agent-host threads' committed runs list beside the run tables' rows.
  const { runs: hostRuns } = useAssistantThreadHostLedger();
  const ledger = useRunLedger(undefined, hostRuns);
  const analytics = useLedgerAnalytics(hostRuns);
  // Per-run cap (budget guardrails, display-only): flags over-cap runs.
  const perRunCapUsd = useAssistantBudgetPreferencesStore((state) => state.perRunCapUsd);
  const ledgerRefresh = ledger.refresh;
  const onRefresh = useCallback(() => {
    void ledgerRefresh();
  }, [ledgerRefresh]);
  return (
    <TaskLedgerPanelView
      analytics={analytics}
      ledger={ledger}
      onRefresh={onRefresh}
      perRunCapUsd={perRunCapUsd}
    />
  );
}
