import { useAssistantBudgetPreferencesStore } from '@brainstrike/app-state/stores/assistant-budget-preferences-store';
import type {
  AssistantRunOutcomeVerdict,
  AssistantThreadRunStatus,
  RunLedgerRow,
} from '@brainstrike/assistant-data';
import { TASK_LEDGER_RUN_LIMIT, useRunLedger } from '@brainstrike/assistant-data/cost-tracking';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  badgeVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@brainstrike/ui';
import { useAssistantThreadHostLedger } from '../assistant-thread-host-context';
import type { LedgerModelComparisonRow } from '../run-ledger-analytics';
import {
  formatDurationMs,
  formatEstimatedCost,
  formatTokensCompact,
  formatUsd,
  modelDisplayName,
} from './cost-format';
import { useLedgerAnalytics } from './use-ledger-analytics';

/** Run-table slice of the view state (structural subset of RunLedgerState). */
export interface TaskLedgerRunsViewState {
  readonly available: boolean;
  readonly rows: readonly RunLedgerRow[];
}

/** Analytics slice of the view state (LedgerAnalyticsState). */
export interface TaskLedgerAnalyticsViewState {
  readonly models: readonly LedgerModelComparisonRow[];
}

interface TaskLedgerPanelViewProps {
  readonly analytics: TaskLedgerAnalyticsViewState;
  readonly ledger: TaskLedgerRunsViewState;
  /** Per-run cost cap in USD (budget guardrails); null/absent = off. */
  readonly perRunCapUsd?: number | null | undefined;
}

/** A run's status as a dot colour; the label always carries the meaning too. */
const STATUS_DOT: Record<AssistantThreadRunStatus, string> = {
  cancelled: 'bg-muted-foreground/50',
  cancelling: 'bg-muted-foreground/50',
  completed: 'bg-success',
  failed: 'bg-destructive',
  running: 'bg-info animate-pulse motion-reduce:animate-none',
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
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
});

/** The model's catalogue name; the provider only when the name does not carry it. */
function ModelName({ model, provider }: { readonly model: string; readonly provider: string }) {
  const names = modelDisplayName(provider, model);
  return (
    <span className="block min-w-0 truncate" title={`${provider}::${model}`}>
      <span className="font-medium">{names.model}</span>
      {names.model.includes(names.provider) ? null : (
        <span className="text-muted-foreground"> · {names.provider}</span>
      )}
    </span>
  );
}

/**
 * Honest per-run cost label. Exact provider-reported cost renders as-is;
 * a registry-priced remainder is explicitly marked "est."; an unpriced model
 * reads "cost unavailable" and a run with no captured usage reads "no usage
 * recorded" — NEVER a fabricated $0 (same contract as the sibling cost panel).
 * A call a Stop cut off, which its provider billed but never reported, is
 * named beside what was recorded, never priced as $0 or guessed.
 */
function runCostLabel(row: RunLedgerRow): string {
  if (row.unreportedCallCount === 0) {
    return recordedCostLabel(row);
  }
  const calls = row.unreportedCallCount === 1 ? '1 call' : `${row.unreportedCallCount} calls`;
  const unreported = `${calls} not reported by the provider`;
  return row.inputTokens + row.outputTokens === 0
    ? 'cost not reported by the provider'
    : `${recordedCostLabel(row)} + ${unreported}`;
}

function recordedCostLabel(row: RunLedgerRow): string {
  if (row.billedCostUsd !== undefined) {
    // Honest partial-cost rule (review #1698): billedCostUsd covers only the
    // provider-reported usage rows. A mixed run's unreported remainder is
    // priced and shown alongside — never silently folded into an "exact" figure.
    if (row.estimatedInputTokens + row.estimatedOutputTokens === 0) {
      return formatUsd(row.billedCostUsd);
    }
    return row.estimatedCostUsd === null
      ? `${formatUsd(row.billedCostUsd)} + unpriced remainder`
      : `${formatUsd(row.billedCostUsd)} + est. ${formatUsd(row.estimatedCostUsd)}`;
  }
  if (row.inputTokens + row.outputTokens === 0) {
    return 'no usage recorded';
  }
  return row.estimatedCostUsd === null ? 'cost unavailable' : formatUsd(row.estimatedCostUsd);
}

/**
 * Whether a run's exact-or-priced cost EXCEEDS the per-run cap. Display-only
 * (budget guardrails v1): exact provider-reported cost is authoritative; a
 * registry-priced estimate is used otherwise. Runs with no usage or an
 * unpriced model are NEVER flagged — a fabricated number must not accuse a
 * run of blowing the budget (honest-cost contract).
 */
export function isRunOverCap(row: RunLedgerRow, perRunCapUsd: number): boolean {
  // An unpriced remainder is never fabricated, so only the priced portions count.
  const total = (row.billedCostUsd ?? 0) + (row.estimatedCostUsd ?? 0);
  return total > perRunCapUsd;
}

function outcomeChipTitle(row: RunLedgerRow): string {
  const source = row.outcomeSource === null ? 'unknown source' : row.outcomeSource;
  return row.outcomeDetail === null
    ? `Labeled by ${source}`
    : `Labeled by ${source}: ${row.outcomeDetail}`;
}

/**
 * Presentational Task Ledger panel — receives resolved states so tests can
 * stub every honest-cost/empty permutation without a live store (same
 * composition as CostAggregationPanelView).
 */
export function TaskLedgerPanelView({ analytics, ledger, perRunCapUsd }: TaskLedgerPanelViewProps) {
  if (!ledger.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
        </CardHeader>
        <CardContent data-testid="task-ledger-panel">
          <p className="text-muted-foreground text-sm" data-testid="task-ledger-session-only">
            The Task Ledger isn’t available here.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <>
      {analytics.models.length > 0 ? <ModelComparisonCard models={analytics.models} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>
            The latest {TASK_LEDGER_RUN_LIMIT} assistant runs. Open one for its token and cost
            breakdown.
          </CardDescription>
        </CardHeader>
        <CardContent data-testid="task-ledger-panel">
          {ledger.rows.length > 0 ? (
            <RunList perRunCapUsd={perRunCapUsd} rows={ledger.rows} />
          ) : (
            <p className="text-muted-foreground text-sm" data-testid="task-ledger-empty">
              No assistant runs recorded yet. Run an assistant turn to start the ledger.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function successRate(row: LedgerModelComparisonRow): string {
  const finished = row.completedRunCount + row.failedRunCount;
  return finished === 0 ? '—' : `${Math.round((row.completedRunCount / finished) * 100)}%`;
}

function modelOutcomesTitle(row: LedgerModelComparisonRow): string {
  const parts = [`${row.completedRunCount} completed`];
  if (row.failedRunCount > 0) {
    parts.push(`${row.failedRunCount} failed`);
  }
  if (row.cancelledRunCount > 0) {
    parts.push(`${row.cancelledRunCount} cancelled`);
  }
  const labeled = row.labeledSucceededCount + row.labeledFailedCount + row.labeledMixedCount;
  if (labeled > 0) {
    parts.push(
      `labeled ${row.labeledSucceededCount} succeeded, ${row.labeledFailedCount} failed, ${row.labeledMixedCount} mixed`
    );
  }
  return parts.join(' · ');
}

function ModelComparisonCard({ models }: { readonly models: readonly LedgerModelComparisonRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
        <CardDescription>
          What each model cost and how its runs went, costliest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="@container">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="w-14 text-right">Runs</TableHead>
              <TableHead className="w-24 text-right">Completed</TableHead>
              <TableHead className="hidden w-24 text-right whitespace-nowrap @xl:table-cell">
                Avg time
              </TableHead>
              <TableHead className="hidden w-20 text-right @md:table-cell">Tokens</TableHead>
              <TableHead className="w-20 text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((row) => (
              <TableRow data-testid="task-ledger-model-row" key={`${row.provider}:${row.model}`}>
                <TableCell>
                  <ModelName model={row.model} provider={row.provider} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.runCount}</TableCell>
                <TableCell className="text-right tabular-nums" title={modelOutcomesTitle(row)}>
                  {successRate(row)}
                </TableCell>
                <TableCell className="hidden text-right whitespace-nowrap tabular-nums @xl:table-cell">
                  {formatDurationMs(row.avgDurationMs)}
                </TableCell>
                <TableCell
                  className="hidden text-right tabular-nums @md:table-cell"
                  title={`${row.inputTokens.toLocaleString()} input (${row.cacheReadTokens.toLocaleString()} cached) · ${row.outputTokens.toLocaleString()} output`}
                >
                  {formatTokensCompact(row.inputTokens + row.outputTokens)}
                </TableCell>
                <TableCell
                  className="text-right font-medium tabular-nums"
                  data-testid="task-ledger-model-cost"
                >
                  {formatEstimatedCost(row.costUsd, row.unpricedRunCount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RunFacts({ row }: { readonly row: RunLedgerRow }) {
  const facts = [
    row.durationMs === null ? null : formatDurationMs(row.durationMs),
    `${row.toolCallCount} tool${row.toolCallCount === 1 ? '' : 's'}`,
    row.editCount === undefined ? null : `${row.editCount} edit${row.editCount === 1 ? '' : 's'}`,
    `${formatTokensCompact(row.inputTokens)} in · ${formatTokensCompact(row.outputTokens)} out`,
  ].filter((fact) => fact !== null);
  return <span className="truncate">{facts.join(' · ')}</span>;
}

/** How the run's cost was reached: billed, priced, or not priceable. */
function costBasis(row: RunLedgerRow): string {
  if (row.estimatedCostUsd === null) {
    return 'a model in this run has no list price';
  }
  if (row.billedCostUsd === undefined) {
    return 'each request priced at its own rate';
  }
  return row.estimatedInputTokens + row.estimatedOutputTokens === 0
    ? 'what the provider billed'
    : 'billed, and the rest priced at its own rate';
}

/** The run's tokens by class, each with what it means for the bill. */
function RunBreakdown({ row }: { readonly row: RunLedgerRow }) {
  const uncached = row.inputTokens - row.cacheReadTokens - row.cacheCreationTokens;
  const lines = [
    ['Input', uncached, 'billed at the input rate'],
    ['Cache read', row.cacheReadTokens, 'billed at the discounted cache rate'],
    ['Cache write', row.cacheCreationTokens, 'billed at the cache write rate'],
    ['Output', row.outputTokens, 'billed at the output rate, reasoning included'],
  ] as const;
  return (
    <dl
      className="bg-muted/40 grid grid-cols-[auto_auto_1fr] gap-x-4 gap-y-1 rounded-md px-3 py-2.5 text-xs"
      data-testid="task-ledger-run-breakdown"
    >
      {lines.map(([label, count, note]) => (
        <div className="contents" key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right font-medium tabular-nums">{count.toLocaleString()}</dd>
          <dd className="text-muted-foreground">{note}</dd>
        </div>
      ))}
      <div className="contents">
        <dt className="text-muted-foreground border-t pt-1">Cost</dt>
        <dd className="border-t pt-1 text-right font-semibold tabular-nums">{runCostLabel(row)}</dd>
        <dd className="text-muted-foreground border-t pt-1">{costBasis(row)}</dd>
      </div>
    </dl>
  );
}

/** Badges as spans: they sit inside the run's disclosure button. */
function RunBadges({
  perRunCapUsd,
  row,
}: {
  readonly perRunCapUsd?: number | null | undefined;
  readonly row: RunLedgerRow;
}) {
  return (
    <>
      {row.failedToolCallCount > 0 ? (
        <span
          className={badgeVariants({ variant: 'destructive' })}
          data-testid="task-ledger-failed-tools"
        >
          {row.failedToolCallCount} failed tool{row.failedToolCallCount === 1 ? '' : 's'}
        </span>
      ) : null}
      {row.revertedEditCount !== undefined && row.revertedEditCount > 0 ? (
        <span
          className={badgeVariants({ variant: 'outline' })}
          data-testid="task-ledger-reverted-edits"
        >
          {row.revertedEditCount} reverted
        </span>
      ) : null}
      {row.outcomeVerdict === null ? null : (
        <span
          className={badgeVariants({ variant: OUTCOME_BADGE_VARIANTS[row.outcomeVerdict] })}
          data-testid="task-ledger-outcome"
          title={outcomeChipTitle(row)}
        >
          {row.outcomeVerdict}
        </span>
      )}
      {typeof perRunCapUsd === 'number' && isRunOverCap(row, perRunCapUsd) ? (
        <span
          className={badgeVariants({ variant: 'destructive' })}
          data-testid="task-ledger-over-cap"
          title={`This run's cost exceeds the per-run cap of ${formatUsd(perRunCapUsd)}.`}
        >
          over cap
        </span>
      ) : null}
    </>
  );
}

function RunList({
  perRunCapUsd,
  rows,
}: {
  readonly perRunCapUsd?: number | null | undefined;
  readonly rows: readonly RunLedgerRow[];
}) {
  return (
    <Accordion className="rounded-md border" collapsible type="single">
      {rows.map((row) => (
        <AccordionItem data-testid="task-ledger-run-row" key={row.runId} value={row.runId}>
          <AccordionTrigger className="hover:bg-muted/40 gap-3 px-3 py-2.5 hover:no-underline">
            <span className="flex min-w-0 flex-1 items-start gap-2.5">
              <span
                aria-hidden="true"
                className={cn('mt-1.5 size-2 shrink-0 rounded-full', STATUS_DOT[row.status])}
              />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex min-w-0 items-center gap-2 font-normal">
                  <ModelName model={row.model} provider={row.provider} />
                </span>
                <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal">
                  <span className="shrink-0 tabular-nums">
                    {startedAtFormatter.format(row.startedAt)}
                  </span>
                  <span className="sr-only">{row.status}</span>
                  {row.status === 'completed' ? null : (
                    <span aria-hidden="true" className="shrink-0">
                      {row.status}
                    </span>
                  )}
                  <RunFacts row={row} />
                  <RunBadges perRunCapUsd={perRunCapUsd} row={row} />
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 text-right text-sm font-semibold tabular-nums',
                  row.estimatedCostUsd === null && 'text-muted-foreground font-normal'
                )}
                data-testid="task-ledger-run-cost"
              >
                {runCostLabel(row)}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-3 pb-3">
            <RunBreakdown row={row} />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

/** Live Task Ledger panels — models and runs from committed host records. */
export function TaskLedgerPanel() {
  const { runs: hostRuns } = useAssistantThreadHostLedger();
  const ledger = useRunLedger(hostRuns);
  const analytics = useLedgerAnalytics(hostRuns);
  // Per-run cap (budget guardrails, display-only): flags over-cap runs.
  const perRunCapUsd = useAssistantBudgetPreferencesStore((state) => state.perRunCapUsd);
  return <TaskLedgerPanelView analytics={analytics} ledger={ledger} perRunCapUsd={perRunCapUsd} />;
}
