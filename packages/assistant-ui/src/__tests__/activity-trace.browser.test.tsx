import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ActivityTrace } from '../activity-trace';

const live = {
  counts: { failed: 0, steps: 1 },
  live: 'Reading app.ts',
  resting: 'Read',
  verbs: 'Read',
  waiting: false,
};
const done = {
  counts: { failed: 0, steps: 1 },
  live: 'Working',
  resting: 'Read',
  verbs: 'Read',
  waiting: false,
};

function px(value: string): number {
  return Number.parseFloat(value);
}

/**
 * Like `container.querySelector`, but throws a readable error instead of
 * handing back `null` disguised as an element via an `as` cast.
 */
function mustFind(container: ParentNode, selector: string): Element {
  const el = container.querySelector(selector);
  if (el === null) {
    throw new Error(`mustFind: no element matched "${selector}"`);
  }
  return el;
}

// Scope, stated exactly: this measures the STATUS ROW (the summary button).
// The trace's header as a whole does change height at the running↔done
// boundary — `.bs-trace-detail` is added and removed wholesale — which is the
// documented design, not a regression (review finding 7).
test('the status row (summary button) keeps one height across live and resting states; the detail slot below it is added/removed at the boundary', () => {
  const { rerender } = render(
    <div className="assistant-ui-panel">
      <ActivityTrace
        detail="src/app.ts"
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={live}
      />
    </div>
  );
  const summaryButton = screen.getByTestId('assistant-activity-summary');
  const liveHeight = summaryButton.getBoundingClientRect().height;
  // The header's height parity rests on the phase glyph's BOX being fixed,
  // not on `min-height` absorbing a difference: the running mark has no
  // intrinsic size of its own and the resting lucide icons are sized by a
  // Tailwind `size-4` this lane cannot see. Pin the box in both states, so a
  // dropped `.bs-trace-phase-glyph` rule fails structurally instead of hiding
  // behind the row's minimum height.
  expect(px(getComputedStyle(mustFind(summaryButton, '.bs-trace-phase-glyph')).blockSize)).toBe(16);
  rerender(
    <div className="assistant-ui-panel">
      <ActivityTrace
        detail={null}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
      />
    </div>
  );
  const restingButton = screen.getByTestId('assistant-activity-summary');
  const doneHeight = restingButton.getBoundingClientRect().height;
  expect(px(getComputedStyle(mustFind(restingButton, '.bs-trace-phase-glyph')).blockSize)).toBe(16);
  expect(Math.abs(liveHeight - doneHeight)).toBeLessThan(1);
});

// The live label is model-influenced too (an MCP tool name plus its target),
// and this lane has NO Tailwind utilities — `min-w-0`/`truncate` on the span
// are inert here, so the one-line invariant has to be owned by
// `.bs-activity-live-label` in overrides.css or it is simply unverified
// (review finding 6).
test('a long live label truncates instead of wrapping the status row taller', () => {
  const row = (summary: typeof live, isActive: boolean) => (
    <div className="assistant-ui-panel" style={{ width: 480 }}>
      <ActivityTrace
        detail={null}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={isActive}
        restingOverride={null}
        summary={summary}
      />
    </div>
  );
  const { rerender } = render(row(done, false));
  const restingHeight = screen
    .getByTestId('assistant-activity-summary')
    .getBoundingClientRect().height;

  rerender(
    row(
      { ...live, live: 'Calling some.very.long.mcp.tool /very/long/path/'.repeat(7).slice(0, 300) },
      true
    )
  );
  expect(screen.getByTestId('assistant-activity-summary').getBoundingClientRect().height).toBe(
    restingHeight
  );
});

test('the detail slot renders only while active and the chevron rotates when open', async () => {
  render(
    <div className="assistant-ui-panel">
      <ActivityTrace
        detail="src/app.ts"
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={live}
      >
        <div>x</div>
      </ActivityTrace>
    </div>
  );
  expect(screen.getByText('src/app.ts')).toBeVisible();
  const button = screen.getByTestId('assistant-activity-summary');
  const glyph = button.querySelector('.bs-trace-glyph') as HTMLElement;
  expect(getComputedStyle(glyph).transform).toBe('none');
  // Wrapped, sleep included: the click flushes a state update AND the active
  // row's elapsed timer ticks every 100ms while this test waits out the
  // chevron transition — unwrapped, both log "not wrapped in act(...)" into
  // every run of this suite.
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(getComputedStyle(glyph).transform).not.toBe('none');
});

// The verb summary is model-influenced text of unbounded length (and a
// `restingOverride` is written by the model outright). With the label
// unshrinkable it pushed the meta segments straight out of the button, so
// "· N steps" — the one part of the row that is always true — was the first
// thing to disappear. The label truncates instead (review finding 4).
test('a long resting headline truncates instead of pushing the step count out of the row', () => {
  const summary = {
    counts: { failed: 0, steps: 3 },
    live: 'Working',
    resting: 'Read',
    verbs: 'Read',
    waiting: false,
  };
  const row = (headline: string) => (
    <div className="assistant-ui-panel" style={{ width: 480 }}>
      <ActivityTrace
        detail={null}
        fallbackMs={12_000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={headline}
        summary={summary}
      />
    </div>
  );
  const { rerender } = render(row('Read 2 files'));
  const shortHeight = screen
    .getByTestId('assistant-activity-summary')
    .getBoundingClientRect().height;

  rerender(row('Read '.repeat(60).slice(0, 300)));
  const button = screen.getByTestId('assistant-activity-summary');
  const steps = screen.getByText('· 3 steps');
  expect(steps.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(steps.getBoundingClientRect().right).toBeLessThanOrEqual(
    button.getBoundingClientRect().right
  );
  // …and the headline ellipsises on ONE line rather than wrapping the row
  // taller (the fixed-height scroll-anchoring rule, spec §4.7).
  expect(button.getBoundingClientRect().height).toBe(shortHeight);
});

/*
 * Phase-2 follow-up. The label element is keyed on its own text, so it
 * re-mounts — and `bs-trace-label-enter` replays — whenever the status row's
 * wording changes; that is the point of the animation. The group's FIRST
 * paint is not a change of wording, though: the whole trace appears at once,
 * and animating the label there made the row arrive twice over.
 *
 * Measured on the RESTING headline, not the live label: the live label also
 * carries `.bs-thinking-shimmer`, whose `animation` shorthand is declared
 * later in overrides.css at equal specificity and therefore replaces the
 * entrance outright — `.bs-trace-label` contributes only its box there. The
 * headline is the label where this animation is actually observable.
 */
test('the status headline enters only when its wording changes, never on the first paint', () => {
  const row = (headline: string) => (
    <div className="assistant-ui-panel">
      <ActivityTrace
        detail={null}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={headline}
        summary={done}
      />
    </div>
  );
  const { container, rerender } = render(row('Read 2 files'));
  expect(getComputedStyle(mustFind(container, '.bs-activity-summary-label')).animationName).toBe(
    'none'
  );

  rerender(row('Edited 1 file'));
  expect(getComputedStyle(mustFind(container, '.bs-activity-summary-label')).animationName).toBe(
    'bs-trace-label-enter'
  );
});

/*
 * The companion half, and the reason the entrance decision cannot be a mount
 * flag read fresh on every render: this component re-renders constantly for
 * reasons that have nothing to do with the wording — the elapsed clock ticks
 * every 100ms while a group is live, and opening the group is a state change
 * of its own. A per-render read flips to the entrance class at the first of
 * those and animates the untouched first label, which is precisely the
 * double-arrival this rule exists to suppress.
 */
test('a re-render that leaves the wording alone never re-triggers the entrance', async () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      <ActivityTrace
        detail={null}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
      >
        <div>x</div>
      </ActivityTrace>
    </div>
  );
  const label = mustFind(container, '.bs-activity-summary-label');
  expect(getComputedStyle(label).animationName).toBe('none');

  await act(async () => {
    screen.getByTestId('assistant-activity-summary').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(screen.getByTestId('assistant-activity-summary')).toHaveAttribute('aria-expanded', 'true');
  expect(getComputedStyle(mustFind(container, '.bs-activity-summary-label')).animationName).toBe(
    'none'
  );
});
