import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContextUsageMeter,
  type OmMeterState,
  ThreadContextMeter,
} from '../context-usage-meter.js';
import { resetContextUsageStore, useContextUsageStore } from '../context-usage-store.js';

// useAuiState must be mocked so ThreadContextMeter can be tested without a
// live AssistantRuntimeProvider. The mock returns a configurable messages list
// and running flag.
let mockMessages: unknown[] = [];
let mockIsRunning = false;
vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(
    selector: (state: { thread: { isRunning: boolean; messages: unknown[] } }) => T
  ) => selector({ thread: { isRunning: mockIsRunning, messages: mockMessages } }),
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

  it('keeps recordUsage provider truth exact regardless of the conversation heuristic (BST-1205)', () => {
    mockMessages = [
      {
        content: [
          {
            result: { content: 'x'.repeat(80_000) },
            toolName: 'brainstrike.readWorkspaceFile',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ];
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 4321, outputTokens: 123 });

    render(<ContextUsageMeter {...props} estimatedTokens={20_000} />);

    expect(screen.getByTestId('context-usage-trigger')).toHaveTextContent(/4\.4K/);
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
    expect(screen.getByText(/older messages may be trimmed/i)).toBeInTheDocument();
  });

  it('keeps the critical trimming-risk notice INLINE (visible without opening the popover)', () => {
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 120_000, outputTokens: 0 });
    render(<ContextUsageMeter {...props} />);
    // Popover closed — the notice must still be visible next to the ring.
    expect(screen.queryByTestId('context-usage-popover')).not.toBeInTheDocument();
    expect(screen.getByTestId('context-usage-critical-notice')).toHaveTextContent(
      /older messages may be trimmed/i
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

  it('does not render the thread-total section when no durable usage is supplied', () => {
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-thread-total')).not.toBeInTheDocument();
  });

  it('qualifies the thread-total cost as a captured-usage estimate (inside the popover)', () => {
    render(
      <ContextUsageMeter
        {...props}
        cumulativeUsage={{
          bySource: [
            { estimated: false, inputTokens: 1_600_000, kind: 'chat', outputTokens: 200_000 },
          ],
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: { available: true, provenance: 'captured-usage-estimate', usdAmount: 12.5 },
          inputTokens: 1_600_000,
          outputTokens: 200_000,
          totalTokens: 1_800_000,
        }}
      />
    );
    openMeterPopover();
    const total = screen.getByTestId('context-usage-thread-total');
    expect(total).toHaveTextContent(/1\.8M tokens/);
    expect(screen.getByTestId('context-usage-thread-total-split')).toHaveTextContent(
      /1\.6M in · 200\.0K out/
    );
    expect(screen.getByTestId('context-usage-cost')).toHaveTextContent(
      /captured usage est\. \$12\.50/i
    );
  });

  it('renders "cost unavailable" (never $0) for an unpriced model', () => {
    render(
      <ContextUsageMeter
        {...props}
        cumulativeUsage={{
          bySource: [{ estimated: false, inputTokens: 800, kind: 'chat', outputTokens: 200 }],
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: { available: false, reason: 'unpriced_model' },
          inputTokens: 800,
          outputTokens: 200,
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

describe('ContextUsageMeter thread-total headline (BST-953)', () => {
  beforeEach(() => {
    resetContextUsageStore();
    mockMessages = [];
  });

  const props = {
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    threadKey: 't1',
  };

  const cumulativeUsage = {
    bySource: [
      { estimated: false, inputTokens: 900_000, kind: 'chat', outputTokens: 90_000 },
      { estimated: false, inputTokens: 40_000, kind: 'subagent', outputTokens: 6000 },
      { estimated: true, inputTokens: 60_000, kind: 'om-observation', outputTokens: 4000 },
    ],
    cacheCreationTokens: 50_000,
    cacheReadTokens: 700_000,
    cacheSavings: { usdAmount: 5.175 },
    cost: { available: true, provenance: 'captured-usage-estimate', usdAmount: 12.5 },
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    totalTokens: 1_100_000,
  } as const;

  it('leads the chip with the overall thread total (+cost), not the context fraction', () => {
    render(<ContextUsageMeter {...props} cumulativeUsage={cumulativeUsage} />);
    const trigger = screen.getByTestId('context-usage-trigger');
    expect(trigger).toHaveTextContent(/1\.1M tokens/);
    expect(screen.getByTestId('context-usage-trigger-cost')).toHaveTextContent(/\$12\.50/);
    // The context fraction moves to the title/popover; the ring still conveys capacity.
    expect(trigger).not.toHaveTextContent(/126\.0K/);
    expect(screen.getByTestId('context-ring')).toBeInTheDocument();
  });

  it('adds the in-flight run live step usage on top of the durable total, marked live', () => {
    act(() => {
      useContextUsageStore
        .getState()
        .recordLiveStepUsage('t1', { inputTokens: 90_000, outputTokens: 10_000 });
    });
    render(<ContextUsageMeter {...props} cumulativeUsage={cumulativeUsage} isRunning={true} />);
    const trigger = screen.getByTestId('context-usage-trigger');
    expect(trigger).toHaveTextContent(/1\.2M tokens/);
    expect(trigger).toHaveTextContent(/live/);
    // The durable cost excludes the live tokens — pairing them would be a
    // current total beside a lagging price (review fix): chip suppresses it,
    // the popover keeps it with an explicit qualifier.
    expect(screen.queryByTestId('context-usage-trigger-cost')).not.toBeInTheDocument();
    openMeterPopover();
    expect(screen.getByTestId('context-usage-cost')).toHaveTextContent(/excl\. live/);
  });

  it('ignores a stranded live sum when no run is in flight (BST-1652)', () => {
    // A run the user switched away from mid-flight leaves a partial sum on its
    // thread key that nothing settles. `isRunning` is the reader-side truth:
    // no run in flight ⇒ no live tokens, so the chip is the durable total with
    // its cost, and the popover never claims a live component.
    act(() => {
      useContextUsageStore
        .getState()
        .recordLiveStepUsage('t1', { inputTokens: 90_000, outputTokens: 10_000 });
    });
    render(<ContextUsageMeter {...props} cumulativeUsage={cumulativeUsage} isRunning={false} />);
    const trigger = screen.getByTestId('context-usage-trigger');
    expect(trigger).toHaveTextContent(/1\.1M tokens/);
    expect(trigger).not.toHaveTextContent(/live/);
    expect(screen.getByTestId('context-usage-trigger-cost')).toHaveTextContent(/\$12\.50/);
    openMeterPopover();
    const popoverTotal = screen.getByTestId('context-usage-thread-total-tokens');
    expect(popoverTotal).toHaveTextContent(/Thread total · 1\.1M tokens/);
    expect(popoverTotal).not.toHaveTextContent(/\(live\)/);
    expect(screen.getByTestId('context-usage-cost')).not.toHaveTextContent(/excl\. live/);
  });

  it('shows the live headline during a NEW thread first run (zero durable baseline)', () => {
    // A repo-backed thread with no rows yet supplies the honest ZERO baseline
    // (EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY in app-shell) — the first run's
    // steps must render as the thread-total headline, not be discarded
    // (review fix).
    const zeroBaseline = {
      bySource: [],
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cost: { available: true, provenance: 'captured-usage-estimate', usdAmount: 0 },
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    } as const;
    act(() => {
      useContextUsageStore
        .getState()
        .recordLiveStepUsage('t1', { inputTokens: 12_000, outputTokens: 400 });
    });
    render(<ContextUsageMeter {...props} cumulativeUsage={zeroBaseline} isRunning={true} />);
    const trigger = screen.getByTestId('context-usage-trigger');
    expect(trigger).toHaveTextContent(/12\.4K tokens/);
    expect(trigger).toHaveTextContent(/live/);
  });

  it('renders the by-source rows and cache savings line inside the popover', () => {
    render(<ContextUsageMeter {...props} cumulativeUsage={cumulativeUsage} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-source-chat')).toHaveTextContent(
      /900\.0K in · 90\.0K out/
    );
    expect(screen.getByTestId('context-usage-source-subagent')).toHaveTextContent(/Subagents/);
    // OM figures are local estimates and must SAY so.
    expect(screen.getByTestId('context-usage-source-om-observation')).toHaveTextContent(
      /Memory observer \(est\.\)/
    );
    expect(screen.getByTestId('context-usage-cache-line')).toHaveTextContent(
      /700\.0K read · 50\.0K written · saved ~\$5\.18/
    );
    // The context section survives BELOW the thread total.
    expect(screen.getByTestId('context-usage-popover-header')).toHaveTextContent(
      /Context .*% full/
    );
  });

  it('omits the by-source list for a single-source thread (no redundant restatement)', () => {
    render(
      <ContextUsageMeter
        {...props}
        cumulativeUsage={{
          ...cumulativeUsage,
          bySource: [
            { estimated: false, inputTokens: 1_000_000, kind: 'chat', outputTokens: 100_000 },
          ],
        }}
      />
    );
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-by-source')).not.toBeInTheDocument();
    expect(screen.getByTestId('context-usage-thread-total')).toBeInTheDocument();
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

  it('renders ACTIONABLE reason copy for the awaiting-observer states (BST-947 CDT finding)', () => {
    const { rerender } = render(
      <ContextUsageMeter
        {...props}
        omSegment={{ kind: 'awaiting-observer', reason: 'model-not-eligible' }}
      />
    );
    openMeterPopover();
    expect(screen.getByTestId('context-usage-om-note')).toHaveTextContent(
      /no recommended observer model is enabled in your model catalog/i
    );
    rerender(
      <ContextUsageMeter
        {...props}
        omSegment={{ kind: 'awaiting-observer', reason: 'no-hosted-chat-provider' }}
      />
    );
    expect(screen.getByTestId('context-usage-om-note')).toHaveTextContent(/paused for this chat/i);
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

  it('counts tool results in the estimate (the v1 text-only walk read absurdly low)', () => {
    mockMessages = [
      { content: [{ text: 'read the file', type: 'text' }], role: 'user' },
      {
        content: [
          {
            argsText: '{"path":"src/big.ts"}',
            result: { content: 'x'.repeat(80_000) },
            toolName: 'brainstrike.readWorkspaceFile',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ];
    render(<ThreadContextMeter {...meterProps} />);
    // ~20K tokens of tool result must show up, not the ~4 tokens of text.
    expect(screen.getByTestId('context-usage-trigger')).toHaveTextContent(/20\.0K/);
    expect(screen.getByText(/est\./)).toBeInTheDocument();
  });

  it('keeps moving WHILE a run streams even after exact usage exists (live estimate)', () => {
    useContextUsageStore
      .getState()
      .recordUsage('test-thread', { inputTokens: 5000, outputTokens: 500 });
    mockIsRunning = true;
    mockMessages = [
      {
        content: [
          {
            argsText: '{}',
            result: { content: 'y'.repeat(120_000) },
            toolName: 'run_shell',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ];
    render(<ThreadContextMeter {...meterProps} />);
    // Live estimate (~30K) exceeds the stale exact figure (5.5K) → the gauge
    // must lead with the estimate and flag it.
    expect(screen.getByTestId('context-usage-trigger')).toHaveTextContent(/30\.0K/);
    expect(screen.getByText(/est\./)).toBeInTheDocument();
    mockIsRunning = false;
  });

  it('floors the live streaming estimate at the last exact figure (context never shrinks)', () => {
    useContextUsageStore
      .getState()
      .recordUsage('test-thread', { inputTokens: 50_000, outputTokens: 2000 });
    mockIsRunning = true;
    mockMessages = [{ content: [{ text: 'short new turn', type: 'text' }], role: 'user' }];
    render(<ThreadContextMeter {...meterProps} />);
    expect(screen.getByTestId('context-usage-trigger')).toHaveTextContent(/52\.0K/);
    expect(screen.getByText(/est\./)).toBeInTheDocument();
    mockIsRunning = false;
  });
});

describe('ContextUsageMeter Cursor-style popover anatomy (BST-940)', () => {
  beforeEach(() => {
    resetContextUsageStore();
    mockMessages = [];
    mockIsRunning = false;
  });

  const props = {
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    threadKey: 't1',
  };

  const v2Breakdown = {
    breakdown: {
      attachmentsCount: 0,
      provenance: 'heuristic',
      systemInstructionsTokens: 1400,
      taskListTokens: 120,
      toolDefinitionsByTool: [
        { name: 'brainstrike.readWorkspaceFile', tokens: 800 },
        { name: 'run_shell', tokens: 700 },
        { name: 'brainstrike.querySelf', tokens: 600 },
        { name: 'skill_search', tokens: 500 },
        { name: 'manageTaskList', tokens: 400 },
        { name: 'tiny_one', tokens: 100 },
        { name: 'tiny_two', tokens: 50 },
      ],
      toolDefinitionsProvenance: 'measured',
      toolDefinitionsTokens: 3150,
    },
    invalid: false,
  } as const;

  it('renders the Tool definitions category with per-tool sub-rows capped at five plus a remainder', () => {
    useContextUsageStore.getState().recordBreakdown('t1', v2Breakdown);
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-tool-definitions')).toHaveTextContent(
      /Tool definitions/
    );
    expect(screen.getByTestId('context-usage-breakdown-tool-definitions')).toHaveTextContent(
      /3\.2K|3\.1K/
    );
    expect(screen.getByTestId('context-usage-tooldef-0')).toHaveTextContent(
      /brainstrike\.readWorkspaceFile/
    );
    expect(screen.getByTestId('context-usage-tooldef-4')).toHaveTextContent(/manageTaskList/);
    expect(screen.queryByTestId('context-usage-tooldef-5')).not.toBeInTheDocument();
    expect(screen.getByTestId('context-usage-tooldef-rest')).toHaveTextContent(/\+2 more tools/);
  });

  it('renders the segmented capacity bar with one segment per non-zero category', () => {
    useContextUsageStore.getState().recordBreakdown('t1', v2Breakdown);
    render(
      <ContextUsageMeter
        {...props}
        conversationEstimate={{
          assistantTextTokens: 500,
          attachmentsCount: 0,
          byTool: [{ name: 'run_shell', tokens: 9000 }],
          reasoningTokens: 200,
          toolTokens: 9000,
          totalTokens: 10_000,
          userTextTokens: 300,
        }}
      />
    );
    openMeterPopover();
    const bar = screen.getByTestId('context-usage-bar');
    const segments = [...bar.querySelectorAll('[data-segment]')].map((el) =>
      el.getAttribute('data-segment')
    );
    expect(segments).toEqual(['system', 'toolDefinitions', 'taskList', 'conversation']);
  });

  it('splits the conversation into user/assistant/reasoning/tool rows with per-tool attribution', () => {
    render(
      <ContextUsageMeter
        {...props}
        conversationEstimate={{
          assistantTextTokens: 500,
          attachmentsCount: 1,
          byTool: [
            { name: 'run_shell', tokens: 9000 },
            { name: 'brainstrike.search', tokens: 1000 },
          ],
          reasoningTokens: 200,
          toolTokens: 10_000,
          totalTokens: 11_000,
          userTextTokens: 300,
        }}
      />
    );
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-conversation')).toHaveTextContent(/11\.0K/);
    expect(screen.getByTestId('context-usage-conv-user')).toHaveTextContent(/You/);
    expect(screen.getByTestId('context-usage-conv-assistant')).toHaveTextContent(/Assistant/);
    expect(screen.getByTestId('context-usage-conv-reasoning')).toHaveTextContent(/Reasoning/);
    expect(screen.getByTestId('context-usage-conv-tools')).toHaveTextContent(/10\.0K/);
    expect(screen.getByTestId('context-usage-conv-tool-0')).toHaveTextContent(/run_shell/);
    expect(screen.getByTestId('context-usage-conv-tool-1')).toHaveTextContent(
      /brainstrike\.search/
    );
    // Client-walk attachments render without a fabricated token figure.
    expect(screen.getByTestId('context-usage-breakdown-attachments')).toHaveTextContent(
      /1 attached/
    );
  });

  it('includes tool definitions in the Unattributed subtraction once exact usage lands', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 1000,
        provenance: 'heuristic',
        systemInstructionsTokens: 2000,
        toolDefinitionsTokens: 3000,
      },
      invalid: false,
    });
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 10_000, outputTokens: 100 });
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    // 10_000 − (2000 + 3000 + 1000) = 4_000
    expect(screen.getByTestId('context-usage-breakdown-unattributed')).toHaveTextContent(/4\.0K/);
  });

  it('preserves a measured ZERO wire attachment count over stale client history (review fix)', () => {
    // Wire IS the conversation (historyMessagesTokens present) and measured 0
    // attachments — an older image lingering in UI history must not render an
    // Attachments row claiming it participates in the prompt.
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 500,
        provenance: 'heuristic',
        systemInstructionsTokens: 100,
      },
      invalid: false,
    });
    render(
      <ContextUsageMeter
        {...props}
        conversationEstimate={{
          assistantTextTokens: 0,
          attachmentsCount: 2,
          byTool: [],
          reasoningTokens: 0,
          toolTokens: 0,
          totalTokens: 10,
          userTextTokens: 10,
        }}
      />
    );
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-breakdown-attachments')).not.toBeInTheDocument();
  });

  it('lets the client walk speak for attachments on memory-backed runs (wire is only the turn)', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        provenance: 'heuristic',
        systemInstructionsTokens: 100,
      },
      invalid: false,
    });
    render(
      <ContextUsageMeter
        {...props}
        conversationEstimate={{
          assistantTextTokens: 0,
          attachmentsCount: 2,
          byTool: [],
          reasoningTokens: 0,
          toolTokens: 0,
          totalTokens: 10,
          userTextTokens: 10,
        }}
      />
    );
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-attachments')).toHaveTextContent(
      /2 attached/
    );
  });
});
