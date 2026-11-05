import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadContextMeter } from '../context-usage-meter.js';
import { resetContextUsageStore, useContextUsageStore } from '../context-usage-store.js';

let mockDraft = '';
vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(
    selector: (state: {
      composer: { text: string };
      thread: { isRunning: boolean; messages: unknown[] };
    }) => T
  ) => selector({ composer: { text: mockDraft }, thread: { isRunning: false, messages: [] } }),
}));

const meterProps = {
  contextWindow: 200_000,
  effectiveInputBudget: 126_000,
  threadKey: 'draft-thread',
};

describe('ThreadContextMeter with an unsent draft', () => {
  beforeEach(() => {
    resetContextUsageStore();
    mockDraft = '';
  });

  it('shows the draft as a "+N tokens" hint beside the context figure', () => {
    useContextUsageStore
      .getState()
      .recordUsage('draft-thread', { inputTokens: 5000, outputTokens: 500 });
    mockDraft = 'x'.repeat(1200);
    render(<ThreadContextMeter {...meterProps} />);

    expect(screen.getByTestId('context-usage-draft')).toHaveTextContent('+300 tokens');
    // The context figure itself stays the conversation's own.
    expect(screen.getByTestId('context-usage-trigger')).toHaveTextContent(/5\.5K/u);
    expect(screen.getByTestId('context-usage-trigger')).toHaveAccessibleName(/draft \+300 tokens/u);
  });

  it('shows no draft hint while the composer is empty', () => {
    render(<ThreadContextMeter {...meterProps} />);
    expect(screen.queryByTestId('context-usage-draft')).not.toBeInTheDocument();
  });

  it('warns before sending a draft that would take the context near its budget', () => {
    useContextUsageStore
      .getState()
      .recordUsage('draft-thread', { inputTokens: 60_000, outputTokens: 0 });
    const { rerender } = render(<ThreadContextMeter {...meterProps} />);
    expect(screen.queryByTestId('context-usage-critical-notice')).not.toBeInTheDocument();

    mockDraft = 'x'.repeat(4 * 60_000);
    rerender(<ThreadContextMeter {...meterProps} />);

    expect(screen.getByTestId('context-usage-critical-notice')).toHaveTextContent(
      /Sending this draft approaches the input budget/u
    );
  });
});
