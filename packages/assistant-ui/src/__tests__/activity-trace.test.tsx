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
  verbs: 'Read, searched',
  waiting: false,
};
const done: ActivitySummary = {
  counts: { failed: 0, steps: 3 },
  live: 'Working',
  resting: 'Read 2 files, ran',
  verbs: 'Read 2 files, ran',
  waiting: false,
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
    // The meta segments carry their own separator (there is no whitespace
    // between the spans — the gap is CSS), so the done meta reads
    // "· Worked for Ns" like every other segment. Cancelled is the one
    // exception: "Stopped after 4.0s" is one phrase, pinned below.
    expect(summary).toHaveTextContent('· Worked for 12.0s');
    expect(summary).toHaveTextContent('· 3 steps');
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

  // A cancelled/failed group whose only step never settled has NO verb
  // summary — `summary.resting` is then the placeholder ("Worked"/"Thought"),
  // and demoting that into the meta read "Stopped after 4.0s · Worked · 1
  // step" (review finding 1). The model reports `verbs: null` for exactly
  // this case and the meta segment disappears with it.
  it('omits the verb meta when a cancelled group has no settled step', () => {
    render(
      <ActivityTrace
        detail={null}
        fallbackMs={4000}
        incompleteReason="cancelled"
        isActive={false}
        restingOverride={null}
        summary={{
          counts: { failed: 0, steps: 1 },
          live: 'Working',
          resting: 'Worked',
          verbs: null,
          waiting: false,
        }}
      />
    );
    const row = screen
      .getByTestId('assistant-activity-summary')
      .querySelector('.bs-activity-summary-row');
    expect(row?.textContent).toBe('Stopped after 4.0s· 1 step');
  });

  // `button` children are presentational per ARIA (several screen readers
  // prune the subtree), so a live region nested inside the toggle may never
  // fire; and the static `aria-label` suppressed the whole summary from the
  // accessible name. The announcement is a sibling of the button, and the
  // button is DESCRIBED BY the summary row so the verb summary, elapsed and
  // counts reach AT (review finding 3).
  it('keeps the live region outside the button and describes the button with the summary row', () => {
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
    const group = screen.getByTestId('assistant-activity-group');
    const button = screen.getByTestId('assistant-activity-summary');
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy ?? '');
    expect(description).toHaveTextContent('Read 2 files, ran');
    const liveRegion = group.querySelector('.sr-only[aria-live="polite"]');
    expect(liveRegion).toHaveTextContent('Finished');
    expect(button.contains(liveRegion)).toBe(false);
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

    // BST-1679 task 6: `requires-action` (approval gate / tool-suspend pause)
    // keeps the group's own `isActive` true, so without this the elapsed
    // clock would keep ticking through the user's deliberation — inflating
    // the eventual "Worked for Ns" and, for an abandoned pause, ticking
    // forever. The header stays active (`summary.live` drives the badge
    // question, not `isActive`) so the elapsed badge freezes rather than
    // disappearing — chosen over hiding it so the header's height never
    // shifts across the running → waiting → running cycle.
    // The gate wins the LABEL race even while a sibling call still runs, but
    // that run is not blocked on the user — `summary.waiting` is false there
    // and the clock must keep ticking (review finding 6). The label alone
    // would have frozen it.
    it('keeps ticking while a gate is open but another tool is still running', () => {
      vi.useFakeTimers();
      try {
        const gatedWhileRunning: ActivitySummary = {
          counts: { failed: 0, steps: 2 },
          live: 'Waiting for approval',
          resting: 'Read a.ts, ran',
          verbs: 'Read a.ts, ran',
          waiting: false,
        };
        render(
          <ActivityTrace
            detail={null}
            fallbackMs={undefined}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={gatedWhileRunning}
          />
        );
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('1.0s')).toBeInTheDocument();
        act(() => {
          vi.advanceTimersByTime(2000);
        });
        expect(screen.getByText('3.0s')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('freezes the elapsed badge while the summary reads waiting', () => {
      vi.useFakeTimers();
      try {
        const reading: ActivitySummary = {
          counts: { failed: 0, steps: 1 },
          live: 'Reading a.ts',
          resting: 'Read a.ts',
          verbs: 'Read a.ts',
          waiting: false,
        };
        const waitingForApproval: ActivitySummary = {
          counts: { failed: 0, steps: 1 },
          live: 'Waiting for approval',
          resting: 'Read a.ts',
          verbs: 'Read a.ts',
          waiting: true,
        };
        const { rerender } = render(
          <ActivityTrace
            detail={null}
            fallbackMs={undefined}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={reading}
          />
        );
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(screen.getByText('1.0s')).toBeInTheDocument();

        rerender(
          <ActivityTrace
            detail={null}
            fallbackMs={undefined}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={waitingForApproval}
          />
        );
        act(() => {
          vi.advanceTimersByTime(5000);
        });
        expect(screen.getByText('1.0s')).toBeInTheDocument();

        rerender(
          <ActivityTrace
            detail={null}
            fallbackMs={undefined}
            incompleteReason={undefined}
            isActive
            restingOverride={null}
            summary={reading}
          />
        );
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(screen.getByText('1.5s')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
