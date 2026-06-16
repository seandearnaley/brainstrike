import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantActivityGroup,
  formatActivityDuration,
  runEventsSpanMs,
  summarizeToolActivity,
  type ToolActivitySummary,
} from '../assistant-activity-group';

const toolPart = (overrides: Record<string, unknown>) => ({
  type: 'tool-call',
  toolName: 'brainstrike.grepSearch',
  ...overrides,
});

const runEventPart = (timestamp: string) => ({
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
  data: { id: timestamp, kind: 'tool.started', label: 'x', status: 'completed', timestamp },
});

describe('summarizeToolActivity', () => {
  it('counts steps, running, and incomplete failures', () => {
    const summary = summarizeToolActivity([
      toolPart({ status: { type: 'complete' } }),
      toolPart({ status: { type: 'running' } }),
      toolPart({ status: { type: 'incomplete' } }),
      { type: 'reasoning', status: { type: 'complete' } },
    ]);

    expect(summary.stepCount).toBe(3);
    expect(summary.runningCount).toBe(1);
    expect(summary.failedCount).toBe(1);
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

  it('renders the done summary with elapsed fallback and step count', () => {
    render(<AssistantActivityGroup fallbackMs={12_000} isActive={false} summary={doneSummary} />);

    expect(screen.getByText('Worked')).toBeInTheDocument();
    expect(screen.getByText(/for 12\.0s/)).toBeInTheDocument();
    expect(screen.getByText(/5 steps/)).toBeInTheDocument();
    // Auto-collapsed when not active.
    expect(screen.getByTestId('assistant-activity-body')).toHaveAttribute('hidden');
  });

  it('marks the group failed when a step failed', () => {
    render(
      <AssistantActivityGroup isActive={false} summary={{ ...doneSummary, failedCount: 1 }} />
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
});
