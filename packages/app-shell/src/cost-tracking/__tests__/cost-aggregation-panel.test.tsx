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
          rootId: 'root-a',
          rootDisplayName: 'project-alpha',
          provider: 'openai',
          model: 'gpt-5.2',
          inputTokens: 1000,
          outputTokens: 200,
        },
      ],
    });

    render(<CostAggregationPanelView state={state} />);

    expect(screen.getByText('project-alpha')).toBeInTheDocument();
    const cost = screen.getByTestId('cost-aggregation-cost');
    // openai gpt-5.2 pricing (registry): (1000*1.25 + 200*10)/1e6 = $0.00325.
    expect(cost).toHaveTextContent(/\$0\.003/);
    expect(cost).not.toHaveTextContent('cost unavailable');
  });

  it('renders "cost unavailable" (never $0) for a root with an unpriced model', () => {
    const state = makeState({
      rows: [
        {
          rootId: 'root-local',
          rootDisplayName: 'local-root',
          provider: 'local',
          model: 'gemma',
          inputTokens: 500,
          outputTokens: 100,
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
          rootId: null,
          rootDisplayName: null,
          provider: 'openai',
          model: 'gpt-5.2',
          inputTokens: 10,
          outputTokens: 5,
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
});
