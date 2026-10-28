import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type LedgerTrendPoint, NO_LEDGER_USAGE } from '../../run-ledger-analytics';
import { CostOverviewPanelView } from '../cost-overview-panel';

const totals = {
  cacheReadTokens: 600_000,
  cacheWriteTokens: 50_000,
  costUsd: 3.5,
  inputTokens: 1_000_000,
  outputTokens: 40_000,
  runCount: 7,
  unpricedRunCount: 0,
};

function day(overrides: Partial<LedgerTrendPoint> & { readonly day: string }): LedgerTrendPoint {
  return { ...NO_LEDGER_USAGE, label: overrides.day.slice(5), runCount: 1, ...overrides };
}

describe('CostOverviewPanelView', () => {
  it('leads with the total spend and how much input came from the cache', () => {
    render(<CostOverviewPanelView available totals={totals} trend={[]} />);

    expect(screen.getByTestId('cost-overview-total')).toHaveTextContent('$3.50');
    expect(screen.getByTestId('cost-overview-total')).toHaveTextContent('7 runs');
    expect(screen.getByTestId('cost-overview-average')).toHaveTextContent('$0.50');
    expect(screen.getByTestId('cost-overview-input')).toHaveTextContent('1.0M');
    expect(screen.getByTestId('cost-overview-input')).toHaveTextContent('60% read from cache');
    // Uncached input is what is left after the cache read and write shares.
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Input 350.0K, Cache read 600.0K, Cache write 50.0K, Output 40.0K'
    );
  });

  it('marks a total that leaves unpriced runs out', () => {
    render(
      <CostOverviewPanelView available totals={{ ...totals, unpricedRunCount: 2 }} trend={[]} />
    );

    expect(screen.getByTestId('cost-overview-total')).toHaveTextContent('$3.50+');
    expect(screen.getByTestId('cost-overview-total')).toHaveTextContent('2 unpriced runs left out');
  });

  it('calls the average unavailable when no run could be priced', () => {
    render(
      <CostOverviewPanelView
        available
        totals={{ ...totals, costUsd: 0, unpricedRunCount: totals.runCount }}
        trend={[]}
      />
    );

    expect(screen.getByTestId('cost-overview-total')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('cost-overview-average')).toHaveTextContent('unavailable');
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('draws one bar per day, the costliest at full height', () => {
    render(
      <CostOverviewPanelView
        available
        totals={totals}
        trend={[
          day({ costUsd: 1, day: '2026-10-26' }),
          day({ costUsd: 2.5, day: '2026-10-27', runCount: 6 }),
        ]}
      />
    );

    const bars = screen.getAllByTestId('task-ledger-trend-bar');
    expect(bars).toHaveLength(2);
    expect(bars[1]).toHaveAccessibleName('10-27: $2.50 across 6 runs, 0 tokens');
    expect(bars[1]?.firstElementChild).toHaveStyle({ height: '100%' });
    expect(bars[0]?.firstElementChild).toHaveStyle({ height: '40%' });
  });

  it('says why there is nothing to show instead of drawing zeros', () => {
    render(<CostOverviewPanelView available totals={NO_LEDGER_USAGE} trend={[]} />);
    expect(screen.getByTestId('cost-overview-empty')).toHaveTextContent(/no assistant runs/i);

    render(<CostOverviewPanelView available={false} totals={totals} trend={[]} />);
    expect(screen.getAllByTestId('cost-overview-empty')[1]).toHaveTextContent(/desktop/i);
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});
