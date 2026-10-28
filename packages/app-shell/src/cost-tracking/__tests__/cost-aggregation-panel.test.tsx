import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CostAggregationPanelView } from '../cost-aggregation-panel';
import type { CrossRootCostState } from '../use-cross-root-cost';

type UsageRow = CrossRootCostState['rows'][number];

function usageRow(overrides: Partial<UsageRow>): UsageRow {
  return {
    checkoutBranch: null,
    estimatedCostUsd: 0,
    inputTokens: 0,
    localRootId: null,
    model: 'gpt-5.2',
    outputTokens: 0,
    provider: 'openai',
    rootDisplayName: null,
    rootId: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<CrossRootCostState>): CrossRootCostState {
  return {
    available: true,
    error: null,
    loading: false,
    rows: [],
    ...overrides,
  };
}

describe('CostAggregationPanelView', () => {
  it('renders an honest session-only state on web (db absent), not zeros', () => {
    render(<CostAggregationPanelView state={makeState({ available: false })} />);

    expect(screen.getByTestId('cost-aggregation-session-only')).toBeInTheDocument();
    expect(screen.queryByTestId('cost-aggregation-row')).not.toBeInTheDocument();
    // No fabricated $0.00 anywhere in the web fallback.
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('renders one priced row per root using the joined display name', () => {
    const state = makeState({
      rows: [
        usageRow({
          estimatedCostUsd: 0.0042,
          inputTokens: 1000,
          outputTokens: 200,
          rootDisplayName: 'project-alpha',
          rootId: 'root-a',
        }),
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    expect(screen.getByText('project-alpha')).toBeInTheDocument();
    const cost = screen.getByTestId('cost-aggregation-cost');
    expect(cost).toHaveTextContent('$0.0042');
    expect(cost).not.toHaveTextContent('cost unavailable');
  });

  it('renders "cost unavailable" (never $0) for a root with an unpriced model', () => {
    const state = makeState({
      rows: [
        usageRow({
          estimatedCostUsd: null,
          inputTokens: 500,
          model: 'vendor/uncatalogued',
          outputTokens: 100,
          provider: 'openrouter',
          rootDisplayName: 'unpriced-root',
          rootId: 'root-unpriced',
        }),
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    const cost = screen.getByTestId('cost-aggregation-cost');
    expect(cost).toHaveTextContent('cost unavailable');
    expect(cost).not.toHaveTextContent('$0.00');
  });

  it('labels the null-root bucket as Unattributed', () => {
    const state = makeState({
      rows: [usageRow({ estimatedCostUsd: 0.000_087_5, inputTokens: 10, outputTokens: 5 })],
    });

    render(<CostAggregationPanelView state={state} />);

    expect(screen.getByText('Unattributed')).toBeInTheDocument();
  });

  it('marks a worktree and names its branch', () => {
    const state = makeState({
      rows: [
        usageRow({
          checkoutBranch: 'cost/ledger-redesign',
          estimatedCostUsd: 0.5,
          inputTokens: 100,
          localRootId: 'root-main',
          rootDisplayName: 'Brainstrike',
          rootId: 'root-wt',
        }),
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    const row = screen.getByTestId('cost-aggregation-row');
    expect(row).toHaveTextContent('Brainstrike');
    expect(row).toHaveTextContent(/worktree/i);
    expect(screen.getByTestId('cost-aggregation-branch')).toHaveTextContent('cost/ledger-redesign');
  });

  it('lists the costliest workspace first', () => {
    const state = makeState({
      rows: [
        usageRow({ estimatedCostUsd: 0.1, inputTokens: 1, rootDisplayName: 'cheap', rootId: 'a' }),
        usageRow({ estimatedCostUsd: 2, inputTokens: 1, rootDisplayName: 'dear', rootId: 'b' }),
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    expect(screen.getAllByTestId('cost-aggregation-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('dear'),
      expect.stringContaining('cheap'),
    ]);
  });

  it('shows an empty hint when the durable store has no usage yet', () => {
    render(<CostAggregationPanelView state={makeState({ rows: [] })} />);

    expect(screen.getByTestId('cost-aggregation-empty')).toBeInTheDocument();
  });

  it('surfaces a load error (e.g. a malformed row) as a visible error, never zeros', () => {
    render(
      <CostAggregationPanelView
        state={makeState({ error: new Error('malformed aggregate'), rows: [] })}
      />
    );

    expect(screen.getByTestId('cost-aggregation-error')).toBeInTheDocument();
    expect(screen.queryByTestId('cost-aggregation-row')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});
