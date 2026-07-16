import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RunLedgerRow } from '../../assistant-memory-repository';
import type { LedgerModelComparisonRow, LedgerTrendPoint } from '../../run-ledger-analytics';
import {
  type TaskLedgerAnalyticsViewState,
  TaskLedgerPanelView,
  type TaskLedgerRunsViewState,
} from '../task-ledger-panel';

function makeRun(overrides: Partial<RunLedgerRow> & { runId: string }): RunLedgerRow {
  return {
    completedAt: new Date('2026-07-15T12:00:05Z'),
    durationMs: 5000,
    editCount: 0,
    failedToolCallCount: 0,
    inputTokens: 1000,
    model: 'gpt-5.2',
    outcomeDetail: null,
    outcomeSource: null,
    outcomeVerdict: null,
    outputTokens: 200,
    provider: 'openai',
    revertedEditCount: 0,
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
    cancelledRunCount: 0,
    completedRunCount: 14,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    failedRunCount: 1,
    inputTokens: 150_000,
    labeledFailedCount: 1,
    labeledMixedCount: 0,
    labeledSucceededCount: 14,
    model: 'gpt-5.2',
    outputTokens: 30_000,
    provider: 'openai',
    runCount: 15,
    ...overrides,
  };
}

function makeTrendPoint(overrides: Partial<LedgerTrendPoint> = {}): LedgerTrendPoint {
  return {
    bucketStart: new Date('2026-07-14T00:00:00Z'),
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    inputTokens: 1000,
    outputTokens: 200,
    runCount: 3,
    ...overrides,
  };
}

function makeLedger(overrides: Partial<TaskLedgerRunsViewState> = {}): TaskLedgerRunsViewState {
  return { available: true, error: null, loading: false, rows: [], ...overrides };
}

function makeAnalytics(
  overrides: Partial<TaskLedgerAnalyticsViewState> = {}
): TaskLedgerAnalyticsViewState {
  return { error: null, loading: false, models: [], trend: [], ...overrides };
}

function renderPanel(options: {
  analytics?: Partial<TaskLedgerAnalyticsViewState>;
  ledger?: Partial<TaskLedgerRunsViewState>;
  onRefresh?: () => void;
}) {
  const onRefresh = options.onRefresh ?? vi.fn();
  render(
    <TaskLedgerPanelView
      analytics={makeAnalytics(options.analytics)}
      ledger={makeLedger(options.ledger)}
      onRefresh={onRefresh}
    />
  );
  return { onRefresh };
}

describe('TaskLedgerPanelView', () => {
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

  it('shows a loading state while the first load is in flight', () => {
    renderPanel({ ledger: { loading: true } });

    expect(screen.getByTestId('task-ledger-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('task-ledger-empty')).not.toBeInTheDocument();
  });

  it('renders a run row with an EXACT cost when the provider reported one', () => {
    renderPanel({
      ledger: { rows: [makeRun({ billedCostUsd: 0.42, runId: 'run-1' })] },
    });

    const row = screen.getByTestId('task-ledger-run-row');
    expect(row).toHaveTextContent('$0.42');
    expect(row).not.toHaveTextContent(/est\./i);
  });

  it('marks a registry-priced cost as an estimate when no exact cost was reported', () => {
    renderPanel({
      ledger: {
        rows: [makeRun({ inputTokens: 1000, outputTokens: 200, runId: 'run-1' })],
      },
    });

    const cost = screen.getByTestId('task-ledger-run-cost');
    // openai gpt-5.2 registry pricing: (1000*1.25 + 200*10)/1e6 = $0.00325.
    expect(cost).toHaveTextContent(/est\./i);
    expect(cost).toHaveTextContent(/\$0\.003/);
    expect(cost).not.toHaveTextContent('$0.00325 exact');
  });

  it('renders "cost unavailable" (never a fabricated $0) for an unpriced model', () => {
    renderPanel({
      ledger: {
        rows: [makeRun({ model: 'gemma', provider: 'local', runId: 'run-1' })],
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

    expect(screen.getByTestId('task-ledger-failed-tools')).toHaveTextContent('2 failed');
    expect(screen.getByTestId('task-ledger-reverted-edits')).toHaveTextContent('1 reverted');
  });

  it('surfaces a ledger load failure as a visible error with a working retry', async () => {
    const user = userEvent.setup();
    const { onRefresh } = renderPanel({
      ledger: { error: new Error('malformed aggregate'), rows: [] },
    });

    expect(screen.getByTestId('task-ledger-error')).toHaveTextContent('malformed aggregate');
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('task-ledger-retry'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('surfaces an analytics load failure independently with retry', async () => {
    const user = userEvent.setup();
    const { onRefresh } = renderPanel({
      analytics: { error: new Error('trend query failed') },
      ledger: { rows: [makeRun({ runId: 'run-1' })] },
    });

    expect(screen.getByTestId('task-ledger-error')).toHaveTextContent('trend query failed');
    // The run table still renders — one section failing must not blank the other.
    expect(screen.getByTestId('task-ledger-run-row')).toBeInTheDocument();

    await user.click(screen.getByTestId('task-ledger-retry'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders one model-comparison row per model with exact cost and estimated-token note', () => {
    renderPanel({
      analytics: {
        models: [
          makeModelRow({ billedCostUsd: 1.25 }),
          makeModelRow({
            estimatedInputTokens: 5000,
            estimatedOutputTokens: 1000,
            model: 'claude-sonnet-4-5',
            provider: 'anthropic',
          }),
        ],
      },
      ledger: { rows: [makeRun({ runId: 'run-1' })] },
    });

    const rows = screen.getAllByTestId('task-ledger-model-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('gpt-5.2');
    expect(rows[0]).toHaveTextContent('$1.25');
    expect(rows[0]).toHaveTextContent('14 succeeded');
    expect(rows[0]).toHaveTextContent('1 failed');
    // No exact cost reported → never a fabricated $0; the estimated remainder is noted.
    expect(rows[1]).not.toHaveTextContent('$0.00');
    expect(rows[1]).toHaveTextContent(/est\. tokens/i);
  });

  it('renders one trend bar per bucket with the exact-cost provenance in its label', () => {
    renderPanel({
      analytics: {
        trend: [
          makeTrendPoint({ billedCostUsd: 0.42 }),
          makeTrendPoint({
            bucketStart: new Date('2026-07-15T00:00:00Z'),
            estimatedInputTokens: 2000,
            estimatedOutputTokens: 500,
            inputTokens: 2000,
            outputTokens: 500,
          }),
        ],
      },
      ledger: { rows: [makeRun({ runId: 'run-1' })] },
    });

    const bars = screen.getAllByTestId('task-ledger-trend-bar');
    expect(bars).toHaveLength(2);
    const firstTitle = bars[0]?.querySelector('title')?.textContent ?? '';
    expect(firstTitle).toContain('$0.42');
    const secondTitle = bars[1]?.querySelector('title')?.textContent ?? '';
    // A bucket with no reported cost says so — it never claims $0.
    expect(secondTitle).toContain('no exact cost reported');
    expect(secondTitle).not.toContain('$0.00');
  });

  it('invokes onRefresh from the header refresh button', async () => {
    const user = userEvent.setup();
    const { onRefresh } = renderPanel({
      ledger: { rows: [makeRun({ runId: 'run-1' })] },
    });

    await user.click(screen.getByTestId('task-ledger-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
