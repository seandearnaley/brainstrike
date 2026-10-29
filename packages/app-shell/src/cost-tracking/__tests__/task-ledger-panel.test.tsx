import '@testing-library/jest-dom/vitest';
import type { RunLedgerRow } from '@brainstrike/assistant-data';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LedgerModelComparisonRow } from '../../run-ledger-analytics';
import {
  isRunOverCap,
  type TaskLedgerAnalyticsViewState,
  TaskLedgerPanelView,
  type TaskLedgerRunsViewState,
} from '../task-ledger-panel';

function makeRun(overrides: Partial<RunLedgerRow> & { runId: string }): RunLedgerRow {
  return {
    completedAt: new Date('2026-07-15T12:00:05Z'),
    durationMs: 5000,
    estimatedCacheCreationTokens: 0,
    estimatedCacheReadTokens: 0,
    // gpt-5.2 lists $1.75 / $14: (1000 * 1.75 + 200 * 14) / 1e6.
    estimatedCostUsd: 0.004_55,
    estimatedInputTokens: 1000,
    estimatedOutputTokens: 200,
    failedToolCallCount: 0,
    inputTokens: 1000,
    model: 'gpt-5.2',
    outcomeDetail: null,
    outcomeSource: null,
    outcomeVerdict: null,
    outputTokens: 200,
    provider: 'openai',
    startedAt: new Date('2026-07-15T12:00:00Z'),
    status: 'completed',
    threadId: 'thread-1',
    toolCallCount: 0,
    ...overrides,
  };
}

function makeModelRow(overrides: Partial<LedgerModelComparisonRow> = {}): LedgerModelComparisonRow {
  return {
    avgDurationMs: 42_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cancelledRunCount: 0,
    completedRunCount: 14,
    costUsd: 1.25,
    failedRunCount: 1,
    inputTokens: 150_000,
    labeledFailedCount: 1,
    labeledMixedCount: 0,
    labeledSucceededCount: 14,
    model: 'gpt-5.2',
    outputTokens: 30_000,
    provider: 'openai',
    runCount: 15,
    unpricedRunCount: 0,
    ...overrides,
  };
}

function makeLedger(overrides: Partial<TaskLedgerRunsViewState> = {}): TaskLedgerRunsViewState {
  return { available: true, rows: [], ...overrides };
}

function makeAnalytics(
  overrides: Partial<TaskLedgerAnalyticsViewState> = {}
): TaskLedgerAnalyticsViewState {
  return { models: [], ...overrides };
}

function renderPanel(options: {
  analytics?: Partial<TaskLedgerAnalyticsViewState>;
  ledger?: Partial<TaskLedgerRunsViewState>;
  perRunCapUsd?: number | null;
}) {
  render(
    <TaskLedgerPanelView
      analytics={makeAnalytics(options.analytics)}
      ledger={makeLedger(options.ledger)}
      perRunCapUsd={options.perRunCapUsd}
    />
  );
}

describe('TaskLedgerPanelView', () => {
  it('surfaces the priced remainder next to a partial exact cost (mixed run)', () => {
    // Review #1698 (codex P2): billedCostUsd covers only reported rows; the
    // unreported remainder must be priced and shown, never silently folded
    // into an "exact" total.
    renderPanel({
      ledger: {
        rows: [
          makeRun({
            billedCostUsd: 0.5,
            estimatedInputTokens: 400,
            estimatedOutputTokens: 100,
            runId: 'run-mixed',
          }),
        ],
      },
    });
    const cost = screen.getByTestId('task-ledger-run-cost');
    expect(cost.textContent).toContain('+ est.');
    expect(cost.textContent).toContain('$0.50');
  });

  it('renders an honest desktop-only state on web, never zeros', () => {
    renderPanel({ ledger: { available: false } });

    expect(screen.getByTestId('task-ledger-session-only')).toBeInTheDocument();
    expect(screen.queryByTestId('task-ledger-run-row')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('shows an explicit empty state when the workspace has no runs yet', () => {
    renderPanel({});

    expect(screen.getByTestId('task-ledger-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('task-ledger-run-row')).not.toBeInTheDocument();
  });

  it('renders a run row with an EXACT cost when the provider reported one', () => {
    renderPanel({
      ledger: {
        rows: [
          makeRun({
            billedCostUsd: 0.42,
            estimatedCostUsd: 0,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            runId: 'run-1',
          }),
        ],
      },
    });

    const row = screen.getByTestId('task-ledger-run-row');
    expect(row).toHaveTextContent('$0.42');
    expect(row).not.toHaveTextContent(/est\./iu);
  });

  it('opens a run into its token classes and cost', () => {
    renderPanel({
      ledger: {
        rows: [
          makeRun({
            estimatedCacheReadTokens: 600,
            estimatedCostUsd: 0.0031,
            estimatedInputTokens: 1000,
            estimatedOutputTokens: 200,
            inputTokens: 1000,
            outputTokens: 200,
            runId: 'run-1',
          }),
        ],
      },
    });

    // A sub-cent cost keeps two significant digits, never a wall of decimals or $0.00.
    expect(screen.getByTestId('task-ledger-run-cost')).toHaveTextContent('$0.0031');
    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.2/u }));
    const breakdown = screen.getByTestId('task-ledger-run-breakdown');
    expect(breakdown).toHaveTextContent(/Input\s*400/u);
    expect(breakdown).toHaveTextContent(/Cache read\s*600/u);
    expect(breakdown).toHaveTextContent(/Output\s*200/u);
    expect(breakdown).toHaveTextContent('$0.0031');
  });

  it('renders "cost unavailable" (never a fabricated $0) for an unpriced model', () => {
    renderPanel({
      ledger: {
        rows: [
          makeRun({
            estimatedCostUsd: null,
            model: 'vendor/uncatalogued',
            provider: 'openrouter',
            runId: 'run-1',
          }),
        ],
      },
    });

    const cost = screen.getByTestId('task-ledger-run-cost');
    expect(cost).toHaveTextContent('cost unavailable');
    expect(cost).not.toHaveTextContent('$0.00');
  });

  it('renders "no usage recorded" (never $0) when a run captured no tokens and no cost', () => {
    renderPanel({
      ledger: {
        rows: [makeRun({ inputTokens: 0, outputTokens: 0, runId: 'run-1' })],
      },
    });

    const cost = screen.getByTestId('task-ledger-run-cost');
    expect(cost).toHaveTextContent('no usage recorded');
    expect(cost).not.toHaveTextContent('$0.00');
  });

  it('renders an outcome chip with the label source in its title, blank when unlabeled', () => {
    renderPanel({
      ledger: {
        rows: [
          makeRun({
            outcomeDetail: 'checkpoint reverted',
            outcomeSource: 'edit_revert',
            outcomeVerdict: 'failed',
            runId: 'run-1',
          }),
          makeRun({ runId: 'run-2' }),
        ],
      },
    });

    const chips = screen.getAllByTestId('task-ledger-outcome');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('failed');
    expect(chips[0]).toHaveAttribute('title', expect.stringContaining('edit_revert'));
    expect(chips[0]).toHaveAttribute('title', expect.stringContaining('checkpoint reverted'));
  });

  it('badges failed tool calls and reverted edits on run rows', () => {
    renderPanel({
      ledger: {
        rows: [
          makeRun({
            editCount: 3,
            failedToolCallCount: 2,
            revertedEditCount: 1,
            runId: 'run-1',
            toolCallCount: 5,
          }),
        ],
      },
    });

    expect(screen.getByTestId('task-ledger-failed-tools')).toHaveTextContent('2 failed tools');
    expect(screen.getByTestId('task-ledger-run-row')).toHaveTextContent('3 edits');
    expect(screen.getByTestId('task-ledger-reverted-edits')).toHaveTextContent('1 reverted');
  });

  it('claims no edit count, not 0, for a run with no edit record', () => {
    renderPanel({ ledger: { rows: [makeRun({ runId: 'run-1' })] } });

    expect(screen.getByTestId('task-ledger-run-row')).not.toHaveTextContent(/edit/u);
    expect(screen.queryByTestId('task-ledger-reverted-edits')).not.toBeInTheDocument();
  });

  it('renders one model row per model under its catalogue name, never $0 for an unpriced one', () => {
    renderPanel({
      analytics: {
        models: [
          makeModelRow(),
          makeModelRow({
            costUsd: 0,
            model: 'vendor/uncatalogued',
            provider: 'openrouter',
            unpricedRunCount: 15,
          }),
        ],
      },
      ledger: { rows: [makeRun({ runId: 'run-1' })] },
    });

    const rows = screen.getAllByTestId('task-ledger-model-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('GPT-5.2');
    expect(rows[0]).toHaveTextContent('$1.25');
    // 14 of 15 finished runs completed.
    expect(rows[0]).toHaveTextContent('93%');
    expect(rows[1]).toHaveTextContent('vendor/uncatalogued');
    expect(rows[1]).toHaveTextContent('unavailable');
    expect(rows[1]).not.toHaveTextContent('$0.00');
  });

  it('badges only runs whose exact-or-priced cost exceeds the per-run cap', () => {
    renderPanel({
      ledger: {
        rows: [
          // Exact cost above the cap → badged.
          makeRun({ billedCostUsd: 2.5, runId: 'run-over' }),
          // Exact cost below the cap → not badged.
          makeRun({ billedCostUsd: 0.1, runId: 'run-under' }),
          // Unpriced model (no exact cost, no registry price) → NEVER badged
          // on a fabricated number.
          makeRun({ model: 'vendor/uncatalogued', provider: 'openrouter', runId: 'run-unpriced' }),
        ],
      },
      perRunCapUsd: 1,
    });

    const badges = screen.getAllByTestId('task-ledger-over-cap');
    expect(badges).toHaveLength(1);
    const overRow = screen
      .getAllByTestId('task-ledger-run-row')
      .find((row) => row.textContent?.includes('$2.50'));
    expect(overRow?.querySelector('[data-testid="task-ledger-over-cap"]')).not.toBeNull();
  });

  it('renders no over-cap badge when the per-run cap is off', () => {
    renderPanel({
      ledger: { rows: [makeRun({ billedCostUsd: 99, runId: 'run-1' })] },
      perRunCapUsd: null,
    });

    expect(screen.queryByTestId('task-ledger-over-cap')).not.toBeInTheDocument();
  });
});

describe('isRunOverCap', () => {
  it('uses exact provider-reported cost when present', () => {
    const reported = { estimatedCostUsd: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0 };
    expect(isRunOverCap(makeRun({ ...reported, billedCostUsd: 1.01, runId: 'r' }), 1)).toBe(true);
    expect(isRunOverCap(makeRun({ ...reported, billedCostUsd: 1, runId: 'r' }), 1)).toBe(false);
  });

  it('falls back to the registry-priced estimate for unreported runs', () => {
    const run = makeRun({ estimatedCostUsd: 31.5, runId: 'r' });
    expect(isRunOverCap(run, 1)).toBe(true);
    expect(isRunOverCap(run, 10_000)).toBe(false);
  });

  it('never flags unpriced or zero-usage runs (no fabricated verdicts)', () => {
    expect(
      isRunOverCap(
        makeRun({
          estimatedCostUsd: null,
          model: 'vendor/uncatalogued',
          provider: 'openrouter',
          runId: 'r',
        }),
        0.0001
      )
    ).toBe(false);
    const idle = {
      estimatedCostUsd: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    expect(isRunOverCap(makeRun({ ...idle, runId: 'r' }), 0.0001)).toBe(false);
  });
});
