import { TooltipProvider } from '@brainstrike/ui';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  type RunVerdictContextValue,
  RunVerdictProvider,
  useRunVerdictContext,
} from '../run-verdict-context';
import { DerivedRunVerdict, RunVerdictButtons, selectFinishedRunId } from '../run-verdict-control';

function runEventPart(data: Record<string, unknown>): Record<string, unknown> {
  return { data, name: 'brainstrike.run-event', type: 'data' };
}

describe('selectFinishedRunId', () => {
  it('returns the runId of a run.finished data part', () => {
    const parts = [
      { text: 'Done.', type: 'text' },
      runEventPart({
        id: 'event-1',
        kind: 'run.finished',
        label: 'Run finished',
        runId: 'run-1',
        status: 'completed',
        timestamp: '2026-07-16T10:00:00.000Z',
      }),
    ];
    expect(selectFinishedRunId(parts)).toBe('run-1');
  });

  it('ignores non-terminal events, failed runs, and malformed parts', () => {
    expect(
      selectFinishedRunId([
        runEventPart({
          id: 'event-1',
          kind: 'tool.completed',
          label: 'Tool',
          runId: 'run-1',
          status: 'completed',
          timestamp: '2026-07-16T10:00:00.000Z',
        }),
        runEventPart({
          id: 'event-2',
          kind: 'run.failed',
          label: 'Run failed',
          runId: 'run-2',
          status: 'failed',
          timestamp: '2026-07-16T10:00:00.000Z',
        }),
        runEventPart({ kind: 'run.finished' }),
        { type: 'text' },
        null,
      ])
    ).toBeNull();
  });

  it('returns null for a run.finished event without a runId (web local runtime)', () => {
    expect(
      selectFinishedRunId([
        runEventPart({
          id: 'event-1',
          kind: 'run.finished',
          label: 'Run finished',
          status: 'completed',
          timestamp: '2026-07-16T10:00:00.000Z',
        }),
      ])
    ).toBeNull();
  });
});

describe('useRunVerdictContext', () => {
  it('returns null without a provider (capability gating)', () => {
    const { result } = renderHook(() => useRunVerdictContext());
    expect(result.current).toBeNull();
  });

  it('returns the provided binding', () => {
    const value: RunVerdictContextValue = { recordVerdict: vi.fn() };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RunVerdictProvider value={value}>{children}</RunVerdictProvider>
    );
    const { result } = renderHook(() => useRunVerdictContext(), { wrapper });
    expect(result.current).toBe(value);
  });
});

describe('RunVerdictButtons', () => {
  function wrap(ui: ReactNode) {
    return render(<TooltipProvider>{ui}</TooltipProvider>);
  }

  it('records a succeeded verdict and marks the choice', async () => {
    const onVerdict = vi.fn().mockResolvedValue(undefined);
    wrap(<RunVerdictButtons onVerdict={onVerdict} />);

    await userEvent.click(screen.getByRole('button', { name: /worked/i }));

    expect(onVerdict).toHaveBeenCalledWith('succeeded');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /worked/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });
  });

  it('records a failed verdict and allows changing the choice afterwards', async () => {
    const onVerdict = vi.fn().mockResolvedValue(undefined);
    wrap(<RunVerdictButtons onVerdict={onVerdict} />);

    await userEvent.click(screen.getByRole('button', { name: /didn't work/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /didn't work/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    await userEvent.click(screen.getByRole('button', { name: /worked/i }));

    expect(onVerdict).toHaveBeenNthCalledWith(1, 'failed');
    expect(onVerdict).toHaveBeenNthCalledWith(2, 'succeeded');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /worked/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: /didn't work/i })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });
  });

  it('shows a visible failure with retry when recording rejects', async () => {
    const onVerdict = vi
      .fn()
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValue(undefined);
    wrap(<RunVerdictButtons onVerdict={onVerdict} />);

    await userEvent.click(screen.getByRole('button', { name: /worked/i }));

    const retry = await screen.findByRole('button', { name: /retry/i });
    await userEvent.click(retry);

    expect(onVerdict).toHaveBeenCalledTimes(2);
    expect(onVerdict).toHaveBeenNthCalledWith(2, 'succeeded');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /worked/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });
  });
});

describe('committed verdicts (host threads)', () => {
  function wrap(ui: ReactNode) {
    return render(<TooltipProvider>{ui}</TooltipProvider>);
  }

  it('shows a committed user verdict as chosen before any click, so it persists across reloads', () => {
    wrap(<RunVerdictButtons committed="failed" onVerdict={vi.fn()} />);
    expect(screen.getByRole('button', { name: /didn't work/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /worked/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('names a hook verdict, with its detail on hover', () => {
    render(<DerivedRunVerdict verdict={{ detail: 'Graded', source: 'hook', verdict: 'mixed' }} />);
    const label = screen.getByTestId('run-verdict-derived');
    expect(label).toHaveTextContent('Hook verdict: mixed');
    expect(label).toHaveAttribute('title', 'Graded');
  });

  // BST-2000: a successful undo read as "Edit revert verdict: failed". The label is
  // the run's (its work was rejected), so it stays 'failed'; the words say so.
  it('says a full undo reverted the edits and marked the run failed', () => {
    render(
      <DerivedRunVerdict
        verdict={{ detail: '1/1 edits reverted', source: 'edit_revert', verdict: 'failed' }}
      />
    );
    const label = screen.getByTestId('run-verdict-derived');
    expect(label).toHaveTextContent(/^Edits reverted · run marked failed$/);
    expect(label).toHaveAttribute('title', '1/1 edits reverted');
  });

  it('says a partial undo reverted some edits and marked the run mixed', () => {
    render(
      <DerivedRunVerdict
        verdict={{ detail: '1/2 edits reverted', source: 'edit_revert', verdict: 'mixed' }}
      />
    );
    expect(screen.getByTestId('run-verdict-derived')).toHaveTextContent(
      /^Some edits reverted · run marked mixed$/
    );
  });
});
