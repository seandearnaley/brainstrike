import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantActivityGroup } from '../assistant-activity-group';
import { runEventsSpanMs, summarizeToolActivity, type ToolActivitySummary } from '../tool-activity';
import { formatActivityDuration } from '../tool-durations';
import { useChainActivityDerivations } from '../use-chain-activity-derivations';

const toolPart = (overrides: Record<string, unknown>) => ({
  toolName: 'brainstrike.grepSearch',
  type: 'tool-call',
  ...overrides,
});

const runEventPart = (timestamp: string) => ({
  data: { id: timestamp, kind: 'tool.started', label: 'x', status: 'completed', timestamp },
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
});

describe('summarizeToolActivity', () => {
  it('counts steps, running, and incomplete failures', () => {
    const summary = summarizeToolActivity([
      toolPart({ status: { type: 'complete' } }),
      toolPart({ status: { type: 'running' } }),
      toolPart({ status: { type: 'incomplete' } }),
      { status: { type: 'complete' }, type: 'reasoning' },
    ]);

    expect(summary.stepCount).toBe(3);
    expect(summary.runningCount).toBe(1);
    expect(summary.failedCount).toBe(1);
  });

  it('counts completed error results once without guessing from domain fields', () => {
    const summary = summarizeToolActivity([
      toolPart({ isError: true, status: { type: 'complete' } }),
      toolPart({ isError: true, status: { type: 'incomplete' } }),
      toolPart({ result: { error: 'ordinary domain data' }, status: { type: 'complete' } }),
    ]);
    expect(summary.failedCount).toBe(2);
    expect(summary.stepCount).toBe(3);
  });

  it('surfaces the running tool name and its primary argument as the active step', () => {
    const summary = summarizeToolActivity([
      toolPart({ status: { type: 'complete' }, toolName: 'first.tool' }),
      toolPart({
        args: { path: 'packages/db/src/registry.ts' },
        status: { type: 'running' },
        toolName: 'brainstrike.grepSearch',
      }),
    ]);

    expect(summary.activeLabel).toBe('brainstrike.grepSearch');
    expect(summary.activeArg).toBe('packages/db/src/registry.ts');
  });

  it('has no active label when nothing is running', () => {
    const summary = summarizeToolActivity([toolPart({ status: { type: 'complete' } })]);
    expect(summary.activeLabel).toBeNull();
    expect(summary.activeArg).toBeNull();
  });
});

describe('runEventsSpanMs', () => {
  it('derives the elapsed fallback only from the current group, retaining message-wide tool durations', () => {
    const first = toolPart({ status: { type: 'complete' }, toolCallId: 'a' });
    const second = toolPart({ status: { type: 'complete' }, toolCallId: 'b' });
    const event = (timestamp: string, toolCallId: string, kind: string) => {
      const part = runEventPart(timestamp);
      return { ...part, data: { ...part.data, kind, metadata: { toolCallId } } };
    };
    const parts = [
      first,
      second,
      event('2026-09-05T10:00:00.000Z', 'a', 'tool.started'),
      event('2026-09-05T10:00:02.000Z', 'a', 'tool.completed'),
      event('2026-09-05T10:00:20.000Z', 'b', 'tool.started'),
      event('2026-09-05T10:00:25.000Z', 'b', 'tool.completed'),
    ];
    const { result } = renderHook(() => useChainActivityDerivations(parts, 'message-1', [first]));
    expect(result.current.activityFallbackMs).toBe(2000);
    expect(result.current.toolActivity.stepCount).toBe(1);
    expect(result.current.toolDurations).toEqual({ a: 2000, b: 5000 });
  });

  it('returns the min→max timestamp span across run events', () => {
    const span = runEventsSpanMs([
      runEventPart('2026-06-16T10:00:00.000Z'),
      runEventPart('2026-06-16T10:00:12.500Z'),
      toolPart({ status: { type: 'complete' } }),
    ]);
    expect(span).toBe(12_500);
  });

  it('returns undefined with fewer than two timestamped events', () => {
    expect(runEventsSpanMs([runEventPart('2026-06-16T10:00:00.000Z')])).toBeUndefined();
    expect(runEventsSpanMs([toolPart({ status: { type: 'complete' } })])).toBeUndefined();
  });
});

describe('formatActivityDuration', () => {
  it('formats sub-second, second, and minute durations', () => {
    expect(formatActivityDuration(420)).toBe('420ms');
    expect(formatActivityDuration(3400)).toBe('3.4s');
    expect(formatActivityDuration(72_000)).toBe('1m 12s');
  });
});

const activeSummary: ToolActivitySummary = {
  activeArg: 'registry.ts',
  activeLabel: 'brainstrike.grepSearch',
  failedCount: 0,
  runningCount: 1,
  stepCount: 2,
};

const doneSummary: ToolActivitySummary = {
  activeArg: null,
  activeLabel: null,
  failedCount: 0,
  runningCount: 0,
  stepCount: 5,
};

describe('AssistantActivityGroup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the live working heartbeat with the active tool while active', () => {
    render(
      <AssistantActivityGroup isActive summary={activeSummary}>
        <div data-testid="child" />
      </AssistantActivityGroup>
    );

    expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent('Working');
    expect(screen.getByText(/brainstrike\.grepSearch/)).toBeInTheDocument();
    // Body is expanded while active.
    expect(screen.getByTestId('assistant-activity-body')).not.toHaveAttribute('hidden');
  });

  it('ticks elapsed time while active', () => {
    render(<AssistantActivityGroup isActive summary={activeSummary} />);

    act(() => {
      vi.advanceTimersByTime(3400);
    });

    expect(screen.getByText('3.4s')).toBeInTheDocument();
  });

  it('seeds the live timer from the elapsed fallback (no flash back to 0)', () => {
    // The group mounts 2s into the turn — the clock must continue from ~2.0s,
    // not reset to 0 (which flashed 1.8s → 0.2s).
    render(<AssistantActivityGroup fallbackMs={2000} isActive summary={activeSummary} />);
    expect(screen.getByText('2.0s')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('3.0s')).toBeInTheDocument();
  });

  it('retains reasoning time when the same group resumes after a completed tool', () => {
    const { rerender } = render(<AssistantActivityGroup isActive summary={activeSummary} />);
    act(() => vi.advanceTimersByTime(3400));
    rerender(<AssistantActivityGroup fallbackMs={1000} isActive={false} summary={doneSummary} />);
    expect(screen.getByText('for 3.4s')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    rerender(<AssistantActivityGroup fallbackMs={1000} isActive summary={activeSummary} />);
    expect(screen.getByText('3.4s')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('4.4s')).toBeInTheDocument();
  });

  it('renders the done summary with elapsed fallback and step count', () => {
    render(<AssistantActivityGroup fallbackMs={12_000} isActive={false} summary={doneSummary} />);

    expect(screen.getByText('Worked')).toBeInTheDocument();
    expect(screen.getByText(/for 12\.0s/)).toBeInTheDocument();
    expect(screen.getByText(/5 steps/)).toBeInTheDocument();
    // Auto-collapsed when not active.
    expect(screen.getByTestId('assistant-activity-body')).toHaveAttribute('hidden');
  });

  it('counts a failed step into the summary without failing the whole group', () => {
    render(
      <AssistantActivityGroup
        fallbackMs={12_000}
        isActive={false}
        summary={{ ...doneSummary, failedCount: 1 }}
      />
    );

    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.getByText('Worked')).toBeInTheDocument();
    expect(screen.getByText(/for 12\.0s/)).toBeInTheDocument();
    expect(screen.getByText(/5 steps/)).toBeInTheDocument();
    expect(screen.getByTestId('assistant-activity-failed-count')).toHaveTextContent('1 failed');
  });

  it('pluralizes the failed-step count', () => {
    render(
      <AssistantActivityGroup isActive={false} summary={{ ...doneSummary, failedCount: 2 }} />
    );

    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.getByTestId('assistant-activity-failed-count')).toHaveTextContent('2 failed');
  });

  it('still marks the group failed for its own incomplete status', () => {
    render(
      <AssistantActivityGroup incompleteReason="error" isActive={false} summary={doneSummary} />
    );

    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'true');
    expect(screen.getByText('Activity failed')).toBeInTheDocument();
  });

  it('lets the user expand a collapsed (done) panel', () => {
    render(<AssistantActivityGroup isActive={false} summary={doneSummary} />);

    const body = screen.getByTestId('assistant-activity-body');
    expect(body).toHaveAttribute('hidden');

    fireEvent.click(screen.getByTestId('assistant-activity-summary'));
    expect(body).not.toHaveAttribute('hidden');
  });

  it('publishes data-state and marks only the live heartbeat as data-live', () => {
    const { container, rerender } = render(
      <AssistantActivityGroup isActive summary={activeSummary}>
        <div />
      </AssistantActivityGroup>
    );
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'running');
    expect(container.querySelectorAll('[data-live="true"]').length).toBeGreaterThan(0);
    rerender(
      <AssistantActivityGroup fallbackMs={1000} isActive={false} summary={doneSummary}>
        <div />
      </AssistantActivityGroup>
    );
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'done');
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });
});
