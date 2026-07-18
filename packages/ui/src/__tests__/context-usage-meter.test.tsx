import { fireEvent, render, screen } from '@testing-library/react';
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

/** Open the meter's detail popover through the focus affordance. */
function openMeterPopover(): void {
  fireEvent.focus(screen.getByTestId('context-usage-trigger'));
}

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

  it('shows the heuristic estimate (flagged) on the compact ring row before any exact usage', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByText(/4\.0K/)).toBeInTheDocument();
    expect(screen.getByText(/est\./)).toBeInTheDocument();
    expect(screen.getByTestId('context-ring')).toBeInTheDocument();
  });

  it('flips to exact once usage is recorded', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 100_000, outputTokens: 8000 });
    render(<ContextUsageMeter {...props} />);
    expect(screen.getByText(/108\.0K/)).toBeInTheDocument();
    expect(screen.queryByText(/est\./)).not.toBeInTheDocument();
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
    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-state', 'warning');
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 120_000, outputTokens: 0 }); // ~95%
    rerender(<ContextUsageMeter {...props} />);
    expect(screen.getByTestId('context-usage-meter')).toHaveAttribute('data-state', 'critical');
    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-state', 'critical');
    expect(screen.getByText(/summarized out of context/i)).toBeInTheDocument();
  });

  it('keeps the critical windowing notice INLINE (visible without opening the popover)', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 120_000, outputTokens: 0 });
    render(<ContextUsageMeter {...props} />);
    // Popover closed — the notice must still be visible next to the ring.
    expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument();
    expect(screen.getByTestId('context-usage-critical-notice')).toHaveTextContent(
      /summarized out of context/i
    );
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

  it('uses effectiveInputBudget as the displayed denominator so ring row and popover tell one story', () => {
    // effectiveInputBudget: 126_000 → "126.0K"; contextWindow: 200_000 stays out
    // of the compact row (it lives in the popover's model-window line + title).
    render(<ContextUsageMeter {...props} estimatedTokens={undefined} />);
    expect(screen.getByTestId('context-usage-trigger')).toHaveTextContent('126.0K');
    expect(screen.getByTestId('context-usage-trigger')).not.toHaveTextContent('200.0K');
    openMeterPopover();
    expect(screen.getByTestId('context-usage-popover-header')).toHaveTextContent(/126\.0K tokens/);
    expect(screen.getByTestId('context-usage-popover-window')).toHaveTextContent(
      /model window 200\.0K tokens/
    );
  });

  it('opens the detail popover on focus and closes it via outside interaction state', () => {
    render(<ContextUsageMeter {...props} />);
    expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument();
    openMeterPopover();
    expect(screen.getByTestId('context-usage-popover')).toBeInTheDocument();
    expect(screen.getByTestId('context-usage-popover-header')).toHaveTextContent(/% full/);
  });

  it('opens the detail popover on click (touch affordance)', () => {
    render(<ContextUsageMeter {...props} />);
    fireEvent.click(screen.getByTestId('context-usage-trigger'));
    expect(screen.getByTestId('context-usage-popover')).toBeInTheDocument();
  });

  it('opens the detail popover on hover', () => {
    render(<ContextUsageMeter {...props} />);
    fireEvent.mouseEnter(screen.getByTestId('context-usage-trigger'));
    expect(screen.getByTestId('context-usage-popover')).toBeInTheDocument();
  });

  it('shows the client conversation estimate as a popover breakdown row before exact usage', () => {
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-conversation')).toHaveTextContent(
      /Conversation \(estimated\)/
    );
    expect(screen.getByTestId('context-usage-breakdown-conversation')).toHaveTextContent(/4\.0K/);
    expect(screen.queryByTestId('context-usage-breakdown-exact')).not.toBeInTheDocument();
  });

  it('shows the exact last-turn usage as a popover breakdown row once recorded', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 100_000, outputTokens: 8000 });
    render(<ContextUsageMeter {...props} estimatedTokens={undefined} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-exact')).toHaveTextContent(/108\.0K/);
    expect(screen.queryByTestId('context-usage-breakdown-conversation')).not.toBeInTheDocument();
  });

  it('does not render the cumulative line when no durable usage is supplied', () => {
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-cumulative')).not.toBeInTheDocument();
  });

  it('qualifies cumulative cost as a captured-usage estimate (inside the popover)', () => {
    render(
      <ContextUsageMeter
        {...props}
        cumulativeUsage={{
          cost: { available: true, provenance: 'captured-usage-estimate', usdAmount: 12.5 },
          totalTokens: 1_800_000,
        }}
      />
    );
    openMeterPopover();
    const cumulative = screen.getByTestId('context-usage-cumulative');
    expect(cumulative).toHaveTextContent(/1\.8M tokens/);
    expect(screen.getByTestId('context-usage-cost')).toHaveTextContent(
      /captured usage est\. \$12\.50/i
    );
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
    openMeterPopover();
    const cost = screen.getByTestId('context-usage-cost');
    expect(cost).toHaveTextContent(/cost unavailable/i);
    expect(cost).not.toHaveTextContent('$0');
  });
});

describe('ContextUsageMeter prompt-breakdown rows (inside the popover)', () => {
  beforeEach(() => {
    resetContextUsageStore();
    mockMessages = [];
  });

  const props = {
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    threadKey: 't1',
  };

  it('renders the server category rows when a breakdown is recorded', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 2,
        historyMessagesTokens: 900,
        provenance: 'heuristic',
        systemInstructionsTokens: 1200,
        taskListTokens: 40,
      },
      invalid: false,
    });
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-system')).toHaveTextContent(
      /System instructions/
    );
    expect(screen.getByTestId('context-usage-breakdown-system')).toHaveTextContent(/1\.2K/);
    expect(screen.getByTestId('context-usage-breakdown-task-list')).toHaveTextContent(/40/);
    // Server wire figure wins over the client estimate and is NOT labelled estimated.
    expect(screen.getByTestId('context-usage-breakdown-conversation')).toHaveTextContent(/900/);
    expect(screen.getByTestId('context-usage-breakdown-conversation')).not.toHaveTextContent(
      /estimated/
    );
    expect(screen.getByTestId('context-usage-breakdown-attachments')).toHaveTextContent(
      /2 attached/
    );
    // No exact usage yet → no Unattributed row (nothing exact to attribute against).
    expect(screen.queryByTestId('context-usage-breakdown-unattributed')).not.toBeInTheDocument();
  });

  it('omits absent categories entirely (never zero-faked rows)', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        provenance: 'heuristic',
        systemInstructionsTokens: 500,
      },
      invalid: false,
    });
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-system')).toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-breakdown-task-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-breakdown-attachments')).not.toBeInTheDocument();
    // Memory-backed breakdown without a client estimate → no conversation row.
    expect(screen.queryByTestId('context-usage-breakdown-conversation')).not.toBeInTheDocument();
  });

  it('shows the explicit Unattributed remainder once exact usage lands', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 900,
        provenance: 'heuristic',
        systemInstructionsTokens: 1200,
        taskListTokens: 100,
      },
      invalid: false,
    });
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 10_000, outputTokens: 500 });
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    // 10_000 − (1200 + 100 + 900) = 7_800
    expect(screen.getByTestId('context-usage-breakdown-unattributed')).toHaveTextContent(/7\.8K/);
  });

  it('clamps a negative Unattributed remainder to 0 (heuristic overshoot is display math)', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 4000,
        provenance: 'heuristic',
        systemInstructionsTokens: 2000,
      },
      invalid: false,
    });
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 5000, outputTokens: 100 });
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    const row = screen.getByTestId('context-usage-breakdown-unattributed');
    expect(row).toHaveTextContent(/~0/);
    expect(row).not.toHaveTextContent('-');
  });

  it('surfaces a malformed breakdown part instead of rendering coerced rows', () => {
    useContextUsageStore.getState().recordBreakdown('t1', { invalid: true });
    render(<ContextUsageMeter {...props} estimatedTokens={4000} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-invalid')).toHaveTextContent(/malformed/i);
    expect(screen.queryByTestId('context-usage-breakdown-system')).not.toBeInTheDocument();
    // The client conversation estimate still renders honestly.
    expect(screen.getByTestId('context-usage-breakdown-conversation')).toHaveTextContent(
      /estimated/
    );
  });

  it('falls back to the conversation estimate when no breakdown was recorded (local runtime path)', () => {
    render(<ContextUsageMeter {...props} estimatedTokens={4000} />);
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-breakdown-system')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-breakdown-invalid')).not.toBeInTheDocument();
    expect(screen.getByTestId('context-usage-breakdown-conversation')).toHaveTextContent(
      /Conversation \(estimated\)/
    );
  });
});

describe('ContextUsageMeter OM informational stats (inside the popover)', () => {
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
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-om-note')).not.toBeInTheDocument();
  });

  it('renders OM as INFORMATIONAL stats (observed tokens + compaction), NOT a budget segment', () => {
    const omSegment: OmMeterState = {
      bufferedObservationTokens: 1000,
      compactionSavedTokens: 30_000,
      kind: 'stats',
      messageTokenThreshold: 30_000,
      observationTokens: 20_000,
      pendingMessageTokens: 14_000,
    };
    render(<ContextUsageMeter {...props} omSegment={omSegment} />);
    openMeterPopover();
    const stats = screen.getByTestId('context-usage-om-stats');
    expect(stats).toBeInTheDocument();
    expect(screen.getByTestId('context-usage-om-active')).toHaveTextContent(/active om/i);
    expect(screen.getByTestId('context-usage-om-active')).toHaveTextContent(/20/);
    expect(screen.getByTestId('context-usage-om-buffered')).toHaveTextContent(/buffered/i);
    expect(screen.getByTestId('context-usage-om-progress')).toHaveTextContent(/14\.0k.*30\.0k/i);
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
        omSegment={{
          bufferedObservationTokens: 0,
          compactionSavedTokens: 0,
          kind: 'stats',
          messageTokenThreshold: 30_000,
          observationTokens: 4000,
          pendingMessageTokens: 500,
        }}
      />
    );
    openMeterPopover();
    expect(screen.getByTestId('context-usage-om-active')).toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-om-compaction')).not.toBeInTheDocument();
  });

  it('shows buffered and pending work instead of claiming zero tokens were observed', () => {
    render(
      <ContextUsageMeter
        {...props}
        omSegment={{
          bufferedObservationTokens: 867,
          compactionSavedTokens: 0,
          kind: 'stats',
          messageTokenThreshold: 30_000,
          observationTokens: 0,
          pendingMessageTokens: 14_600,
        }}
      />
    );
    openMeterPopover();
    const stats = screen.getByTestId('context-usage-om-stats');
    expect(screen.queryByTestId('context-usage-om-active')).not.toBeInTheDocument();
    expect(screen.getByTestId('context-usage-om-buffered')).toHaveTextContent(/867/);
    expect(screen.getByTestId('context-usage-om-progress')).toHaveTextContent(/14\.6k.*30\.0k/i);
    expect(stats).not.toHaveTextContent(/0 tokens observed/i);
  });

  it('FIX 1: loading state stays QUIET (no note, no stats, no empty flash)', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'loading' }} />);
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-om-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
    // The gauge itself still renders.
    expect(screen.getByTestId('context-usage-meter')).toBeInTheDocument();
  });

  it('renders "OM inactive" (never "0 saved") when OM is disabled', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'inactive' }} />);
    openMeterPopover();
    const note = screen.getByTestId('context-usage-om-note');
    expect(note).toHaveTextContent(/inactive/i);
    expect(note).not.toHaveTextContent(/saved/i);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
  });

  it('renders the web "available on desktop" note for chat-only, never zeros', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'chat-only' }} />);
    openMeterPopover();
    const note = screen.getByTestId('context-usage-om-note');
    expect(note).toHaveTextContent(/desktop/i);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
  });

  it('renders an honest empty state when no OM row exists yet', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'empty' }} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-om-note')).toHaveTextContent(/no observations yet/i);
    expect(screen.queryByTestId('context-usage-om-stats')).not.toBeInTheDocument();
  });

  it('renders an honest error state for a malformed OM row (never a fabricated 0)', () => {
    render(<ContextUsageMeter {...props} omSegment={{ kind: 'error', reason: 'bad column' }} />);
    openMeterPopover();
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
    // so estimatedTokens was always undefined and the estimated badge never appeared.
    // This test verifies the fix: messages shaped { content: [{ type:'text', text }] }
    // must produce a positive estimated token count.
    mockMessages = [
      { content: [{ text: 'Hello world, this is a test message.', type: 'text' }] },
      { content: [{ text: 'Another message here.', type: 'text' }] },
    ];
    render(<ThreadContextMeter {...meterProps} />);
    // The meter must show an estimate (flagged with "est.") rather than zero.
    expect(screen.getByTestId('context-usage-meter')).toBeInTheDocument();
    expect(screen.getByText(/est\./)).toBeInTheDocument();
    // The used-token count must be greater than zero.
    const meterEl = screen.getByTestId('context-usage-meter');
    expect(meterEl.textContent).not.toMatch(/^0 /);
  });

  it('does not show the estimated badge when exact usage is already recorded', () => {
    mockMessages = [{ content: [{ text: 'Some text', type: 'text' }] }];
    useContextUsageStore
      .getState()
      .recordUsage('test-thread', { inputTokens: 5000, outputTokens: 500 });
    render(<ThreadContextMeter {...meterProps} />);
    expect(screen.queryByText(/est\./)).not.toBeInTheDocument();
    expect(screen.getByText(/5\.5K/)).toBeInTheDocument();
  });

  it('falls back to parts when content is absent (legacy message shape)', () => {
    // Ensure the content-first fallback doesn't break messages that only carry parts.
    mockMessages = [{ parts: [{ text: 'Legacy parts-only text.', type: 'text' }] }];
    render(<ThreadContextMeter {...meterProps} />);
    expect(screen.getByText(/est\./)).toBeInTheDocument();
  });
});
