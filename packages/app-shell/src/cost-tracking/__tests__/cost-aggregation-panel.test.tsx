import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CostAggregationPanelView } from '../cost-aggregation-panel';
import type { CrossRootCostState } from '../use-cross-root-cost';

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
        {
          inputTokens: 1000,
          model: 'gpt-5.2',
          outputTokens: 200,
          provider: 'openai',
          rootDisplayName: 'project-alpha',
          rootId: 'root-a',
        },
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    expect(screen.getByText('project-alpha')).toBeInTheDocument();
    const cost = screen.getByTestId('cost-aggregation-cost');
    // openai gpt-5.2 pricing (registry): (1000*1.75 + 200*14)/1e6 = $0.00455.
    expect(cost).toHaveTextContent(/\$0\.00455/);
    expect(cost).toHaveTextContent(/captured usage est\./i);
    expect(cost).not.toHaveTextContent('cost unavailable');
  });

  it('renders "cost unavailable" (never $0) for a root with an unpriced model', () => {
    const state = makeState({
      rows: [
        {
          inputTokens: 500,
          model: 'gemma',
          outputTokens: 100,
          provider: 'local',
          rootDisplayName: 'local-root',
          rootId: 'root-local',
        },
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    const cost = screen.getByTestId('cost-aggregation-cost');
    expect(cost).toHaveTextContent('cost unavailable');
    expect(cost).not.toHaveTextContent('$0.00');
  });

  it('labels the null-root bucket as Unattributed', () => {
    const state = makeState({
      rows: [
        {
          inputTokens: 10,
          model: 'gpt-5.2',
          outputTokens: 5,
          provider: 'openai',
          rootDisplayName: null,
          rootId: null,
        },
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    expect(screen.getByText('Unattributed')).toBeInTheDocument();
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
