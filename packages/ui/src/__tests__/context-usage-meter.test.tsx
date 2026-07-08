import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContextUsageMeter,
  type OmMeterState,
  ThreadContextMeter,
} from '../assistant-ui-panel/context-usage-meter.js';
import {
  resetContextUsageStore,
  useContextUsageStore,
} from '../assistant-ui-panel/context-usage-store.js';

// useAuiState must be mocked so ThreadContextMeter can be tested without a
// live AssistantRuntimeProvider. The mock returns a configurable messages list.
let mockMessages: unknown[] = [];
vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(selector: (state: { thread: { messages: unknown[] } }) => T) =>
    selector({ thread: { messages: mockMessages } }),
}));

describe('ContextUsageMeter', () => {
  beforeEach(() => {
    resetContextUsageStore();
    mockMessages = [];
  });

  const props = {
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    estimatedTokens: 4000,
    threadKey: 't1',
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

  it('uses effectiveInputBudget as the displayed denominator so text and bar tell one story', () => {
    // effectiveInputBudget: 126_000 → "126.0K tokens"; contextWindow: 200_000 → "200.0K tokens"
    // The denominator shown to the user must be the budget, not the full window.
    render(<ContextUsageMeter {...props} estimatedTokens={undefined} />);
    expect(screen.getByText(/126\.0K tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/200\.0K tokens/)).not.toBeInTheDocument();
  });

  it('labels the last-turn bar so it is distinct from the cumulative line', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByText(/last turn/i)).toBeInTheDocument();
  });

  it('does not render the cumulative line when no durable usage is supplied', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.queryByTestId('context-usage-cumulative')).not.toBeInTheDocument();
  });

  it('renders the cumulative tokens and exact cost when priced usage is supplied', () => {
    render(
      <ContextUsageMeter
        {...props}
        cumulativeUsage={{
          cost: { available: true, provenance: 'exact-pricing', usdAmount: 12.5 },
          totalTokens: 1_800_000,
        }}
      />
    );
    const cumulative = screen.getByTestId('context-usage-cumulative');
    expect(cumulative).toHaveTextContent(/1\.8M tokens/);
    expect(screen.getByTestId('context-usage-cost')).toHaveTextContent('$12.50');
  });

  it('renders "cost unavailable" (never $0) for an unpriced model', () => {
    render(
      <ContextUsageMeter
        {...props}
        cumulativeUsage={{
          cost: { available: false, reason: 'unpriced_model' },
          totalTokens: 1000,
        }}
      />
    );
    const cost = screen.getByTestId('context-usage-cost');
    expect(cost).toHaveTextContent(/cost unavailable/i);
    expect(cost).not.toHaveTextContent('$0');
  });
});

describe('ContextUsageMeter OM informational stats', () => {
  beforeEach(() => {
    resetContextUsageStore();
    mockMessages = [];
  });

  const props = {
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    threadKey: 't1',
  };

  it('does not render any OM line when omSegment is absent (desktop pre-load / no prop)', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-om-note')).not.toBeInTheDocument();
  });

  it('renders OM as INFORMATIONAL stats (observed tokens + compaction), NOT a budget segment', () => {
    const omSegment: OmMeterState = {
      compactionSavedTokens: 30_000,
      kind: 'stats',
      observationTokens: 20_000,
    };
    render(<ContextUsageMeter {...props} omSegment={omSegment} />);
    const stats = screen.getByTestId('context-usage-om-stats');
    expect(stats).toBeInTheDocument();
    // Informational observed-token stat.
    expect(screen.getByTestId('context-usage-om-observed')).toHaveTextContent(/observed/i);
    expect(screen.getByTestId('context-usage-om-observed')).toHaveTextContent(/20/);
    // Compaction-benefit stat.
    expect(screen.getByTestId('context-usage-om-compaction')).toHaveTextContent(/saved/i);
    expect(screen.getByTestId('context-usage-om-compaction')).toHaveTextContent(/30/);
    // FIX 2: there is NO budget segment bar and NO over-budget marker for OM.
    expect(screen.queryByTestId('context-usage-om-segments')).not.toBeInTheDocument();
    expect(stats).not.toHaveTextContent(/over budget/i);
    expect(stats).not.toHaveTextContent(/free/i);
  });

  it('omits the compaction stat when nothing has been compacted, still shows observed', () => {
    render(
      <ContextUsageMeter
        {...props}
        omSegment={{ compactionSavedTokens: 0, kind: 'stats', observationTokens: 4000 }}
      />
    );
    expect(screen.getByTestId('context-usage-om-observed')).toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-om-compaction')).not.toBeInTheDocument();
  });

  it('FIX 1: loading state stays QUIET (no note, no stats, no empty flash)', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'loading' }} />);
    expect(screen.queryByTestId('context-usage-om-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
    // The chat-vs-budget meter itself still renders.
    expect(screen.getByTestId('context-usage-meter')).toBeInTheDocument();
  });

  it('renders "OM inactive" (never "0 saved") when OM is disabled', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'inactive' }} />);
    const note = screen.getByTestId('context-usage-om-note');
    expect(note).toHaveTextContent(/inactive/i);
    expect(note).not.toHaveTextContent(/saved/i);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
  });

  it('renders the web "available on desktop" note for chat-only, never zeros', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'chat-only' }} />);
    const note = screen.getByTestId('context-usage-om-note');
    expect(note).toHaveTextContent(/desktop/i);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
  });

  it('renders an honest empty state when no OM row exists yet', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'empty' }} />);
    expect(screen.getByTestId('context-usage-om-note')).toHaveTextContent(/no observations yet/i);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
  });

  it('renders an honest error state for a malformed OM row (never a fabricated 0)', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'error', reason: 'bad column' }} />);
    const note = screen.getByTestId('context-usage-om-note');
    expect(note).toHaveTextContent(/unavailable/i);
    expect(note).not.toHaveTextContent(/^0 /);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
  });
});

describe('ThreadContextMeter', () => {
  const meterProps = {
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    threadKey: 'test-thread',
  };

  beforeEach(() => {
    resetContextUsageStore();
    mockMessages = [];
  });

  it('derives an estimated token count from content-shaped messages (content array, not parts)', () => {
    // assistant-ui exposes message text under `content`, not `parts`.
    // The bug: the old code walked `msg.parts` which is always undefined for real messages,
    // so estimatedTokens was always undefined and the "estimated" badge never appeared.
    // This test verifies the fix: messages shaped { content: [{ type:'text', text }] }
    // must produce a positive estimated token count.
    mockMessages = [
      { content: [{ text: 'Hello world, this is a test message.', type: 'text' }] },
      { content: [{ text: 'Another message here.', type: 'text' }] },
    ];
    render(<ThreadContextMeter {...meterProps} />);
    // The meter must show an estimate (flagged with "estimated") rather than zero.
    expect(screen.getByTestId('context-usage-meter')).toBeInTheDocument();
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
    // The used-token count must be greater than zero.
    const meterEl = screen.getByTestId('context-usage-meter');
    expect(meterEl.textContent).not.toMatch(/^0 /);
  });

  it('does not show estimated badge when exact usage is already recorded', () => {
    mockMessages = [{ content: [{ text: 'Some text', type: 'text' }] }];
    useContextUsageStore
      .getState()
      .recordUsage('test-thread', { inputTokens: 5000, outputTokens: 500 });
    render(<ThreadContextMeter {...meterProps} />);
    expect(screen.queryByText(/estimated/i)).not.toBeInTheDocument();
    expect(screen.getByText(/5\.5K/)).toBeInTheDocument();
  });

  it('falls back to parts when content is absent (legacy message shape)', () => {
    // Ensure the content-first fallback doesn't break messages that only carry parts.
    mockMessages = [{ parts: [{ text: 'Legacy parts-only text.', type: 'text' }] }];
    render(<ThreadContextMeter {...meterProps} />);
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
  });
});
