import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContextUsageMeter } from '../assistant-ui-panel/context-usage-meter.js';
import {
  resetContextUsageStore,
  useContextUsageStore,
} from '../assistant-ui-panel/context-usage-store.js';

describe('ContextUsageMeter', () => {
  beforeEach(() => resetContextUsageStore());

  const props = {
    threadKey: 't1',
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    estimatedTokens: 4000,
  };

  it('shows the heuristic estimate (flagged) before any exact usage', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByText(/4\.0K/)).toBeInTheDocument();
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
  });

  it('flips to exact once usage is recorded', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 100_000, outputTokens: 8000 });
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByText(/108\.0K/)).toBeInTheDocument();
    expect(screen.queryByText(/estimated/i)).not.toBeInTheDocument();
  });

  it('reads the active fallback key when no threadKey is provided', () => {
    useContextUsageStore.getState().recordUsage('active', { inputTokens: 5000, outputTokens: 500 });
    render(<ContextUsageMeter {...props} threadKey={undefined} />);
    expect(screen.getByText(/5\.5K/)).toBeInTheDocument();
  });

  it('applies warning state at >=75% of the effective budget and critical at >=90%', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 100_000, outputTokens: 0 }); // ~79%
    const { rerender } = render(<ContextUsageMeter {...props} />);
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'warning');
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 120_000, outputTokens: 0 }); // ~95%
    rerender(<ContextUsageMeter {...props} />);
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'critical');
    expect(screen.getByText(/summarized out of context/i)).toBeInTheDocument();
  });

  it('re-renders reactively when the store changes', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'ok');
    act(() => {
      useContextUsageStore.getState().recordUsage('t1', { inputTokens: 100_000, outputTokens: 0 });
    });
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'warning');
  });

  it('enters warning state at exactly 75% of the effective budget (>= semantics)', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 94_500, outputTokens: 0 }); // exactly 75% of 126_000
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'warning');
  });

  it('renders nothing when no context window is known', () => {
    const { container } = render(
      <ContextUsageMeter {...props} contextWindow={undefined} effectiveInputBudget={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
