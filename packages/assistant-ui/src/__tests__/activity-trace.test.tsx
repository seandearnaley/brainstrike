// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ActivityTrace } from '../activity-trace';
import type { ActivitySummary } from '../activity-trace-model';

const live: ActivitySummary = {
  counts: { failed: 0, steps: 2 },
  live: 'Searching foo',
  resting: 'Read, searched',
};
const done: ActivitySummary = {
  counts: { failed: 0, steps: 3 },
  live: 'Working',
  resting: 'Read 2 files, ran',
};

describe('ActivityTrace', () => {
  it('names the current step while active and stays collapsed', () => {
    render(
      <ActivityTrace
        detail="foo"
        fallbackMs={1500}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={live}
      >
        <div>body</div>
      </ActivityTrace>
    );
    expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent('Searching foo');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('assistant-activity-body')).toHaveAttribute('hidden');
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(1);
    expect(screen.getByText('foo')).toHaveClass('bs-trace-detail');
  });

  it('settles into the verb summary with Worked for as meta', () => {
    render(
      <ActivityTrace
        detail={null}
        fallbackMs={12_000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
      />
    );
    const summary = screen.getByTestId('assistant-activity-summary');
    expect(summary).toHaveTextContent('Read 2 files, ran');
    expect(summary).toHaveTextContent('Worked for 12.0s');
    expect(summary).toHaveTextContent('3 steps');
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(0);
    expect(screen.queryByText('foo')).not.toBeInTheDocument();
  });

  it('prefers a model-written override for the resting headline', () => {
    render(
      <ActivityTrace
        detail={null}
        fallbackMs={undefined}
        incompleteReason={undefined}
        isActive={false}
        restingOverride="Checked the three configs"
        summary={done}
      />
    );
    expect(screen.getByTestId('assistant-activity-summary')).toHaveTextContent(
      'Checked the three configs'
    );
    expect(screen.getByTestId('assistant-activity-summary')).not.toHaveTextContent('Read 2 files');
  });

  it("keeps Stopped and Activity failed as headlines for the group's own incomplete status", () => {
    const { rerender } = render(
      <ActivityTrace
        detail={null}
        fallbackMs={4000}
        incompleteReason="cancelled"
        isActive={false}
        restingOverride={null}
        summary={done}
      />
    );
    expect(screen.getByTestId('assistant-activity-summary')).toHaveTextContent(
      'Stopped after 4.0s'
    );
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    rerender(
      <ActivityTrace
        detail={null}
        fallbackMs={4000}
        incompleteReason="error"
        isActive={false}
        restingOverride={null}
        summary={done}
      />
    );
    expect(screen.getByTestId('assistant-activity-summary')).toHaveTextContent('Activity failed');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'true');
  });

  it('shows the failed count without failing the group', () => {
    render(
      <ActivityTrace
        detail={null}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={{ ...done, counts: { failed: 1, steps: 3 } }}
      />
    );
    expect(screen.getByTestId('assistant-activity-failed-count')).toHaveTextContent('1 failed');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute(
      'data-failed-steps',
      '1'
    );
  });

  it('expands on click and the toggle sticks', async () => {
    const user = userEvent.setup();
    render(
      <ActivityTrace
        detail={null}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
      >
        <div>body</div>
      </ActivityTrace>
    );
    await user.click(screen.getByRole('button', { name: 'Expand activity' }));
    expect(screen.getByTestId('assistant-activity-body')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Collapse activity' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  // Ported from the deleted `assistant-activity-group.test.tsx` (BST-1677) —
  // these three cases pin `useElapsedMs`'s live-timer behavior. Scoped to
  // their own fake-timer lifecycle (rather than the whole describe block) so
  // they don't interfere with the userEvent-driven case above.
  describe('live elapsed timer', () => {
    it('ticks elapsed time while active', () => {
      vi.useFakeTimers();
      try {
        render(
          <ActivityTrace
            detail={null}
            fallbackMs={undefined}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={live}
          />
        );

        act(() => {
          vi.advanceTimersByTime(3400);
        });

        expect(screen.getByText('3.4s')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('seeds the live timer from the elapsed fallback (no flash back to 0)', () => {
      // The trace mounts 2s into the turn — the clock must continue from
      // ~2.0s, not reset to 0 (which flashed 1.8s → 0.2s; BST-1677).
      vi.useFakeTimers();
      try {
        render(
          <ActivityTrace
            detail={null}
            fallbackMs={2000}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={live}
          />
        );
        expect(screen.getByText('2.0s')).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('3.0s')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('retains reasoning time when the same group resumes after a completed tool', () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(
          <ActivityTrace
            detail={null}
            fallbackMs={undefined}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={live}
          />
        );
        act(() => {
          vi.advanceTimersByTime(3400);
        });
        rerender(
          <ActivityTrace
            detail={null}
            fallbackMs={1000}
            incompleteReason={undefined}
            isActive={false}
            restingOverride={null}
            summary={done}
          />
        );
        expect(screen.getByTestId('assistant-activity-summary')).toHaveTextContent(
          'Worked for 3.4s'
        );
        act(() => {
          vi.advanceTimersByTime(500);
        });
        rerender(
          <ActivityTrace
            detail={null}
            fallbackMs={1000}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={live}
          />
        );
        expect(screen.getByText('3.4s')).toBeInTheDocument();
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('4.4s')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
