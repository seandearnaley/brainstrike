import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { expect, test } from 'vitest';
import { ActivityTrace } from '../activity-trace';
import { mustFind, px } from './browser-dom';

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
 * Measured on the RESTING headline, where the entrance is the label's whole
 * animation and `animationName` is therefore exactly `none` or exactly
 * `bs-trace-label-enter`. The live label composes the same entrance with the
 * shimmer (see the compound-rule test at the bottom of this file), so its
 * `animationName` is a two-entry list and reads by containment instead.
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

/*
 * The entrance flag is STICKY once the wording has changed, and that is a
 * deliberate property of `useLabelEnterClass` rather than an accident of it:
 * this component re-renders constantly while a group is live, and toggling
 * the class back to the static form on the first of those would strip the
 * animation off a label still mid-flight. So a repaint that leaves the
 * wording alone keeps both the class and its resolved animation exactly where
 * the change left them.
 */
test('the entrance class is sticky: after a wording change, an unchanged rerender keeps bs-trace-label and its animation', () => {
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
  rerender(row('Edited 1 file'));
  const changed = mustFind(container, '.bs-activity-summary-label');
  expect(changed).toHaveClass('bs-trace-label');
  const changedAnimation = getComputedStyle(changed).animationName;

  rerender(row('Edited 1 file'));
  const repainted = mustFind(container, '.bs-activity-summary-label');
  expect(repainted).toHaveClass('bs-trace-label');
  expect(getComputedStyle(repainted).animationName).toBe(changedAnimation);
});

/*
 * The LIVE label is the one element that carries the entrance class and
 * `.bs-thinking-shimmer` at the same time, and BOTH rules declare the
 * `animation` SHORTHAND at equal specificity — so the shimmer, declared later
 * in overrides.css, replaced the entrance outright and the live label's
 * crossfade never ran once (phase-2 defect, found in the Task 6 review). The
 * compound rules compose the two instead of letting one erase the other:
 * static + shimmer resolves to the shimmer alone, entrance + shimmer to both.
 * Measured as the resolved `animation-name` LIST, since that list is exactly
 * where the collision was.
 */
test('the live label composes its entrance with the shimmer: shimmer alone on first paint, both once the wording changes', () => {
  const row = (liveLabel: string) => (
    <div className="assistant-ui-panel">
      <ActivityTrace
        detail={null}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={{ ...live, live: liveLabel }}
      />
    </div>
  );
  const { container, rerender } = render(row('Reading app.ts'));
  const first = getComputedStyle(mustFind(container, '.bs-activity-live-label')).animationName;
  expect(first).toContain('bs-thinking-shimmer');
  expect(first).not.toContain('bs-trace-label-enter');

  rerender(row('Editing app.ts'));
  const changed = getComputedStyle(mustFind(container, '.bs-activity-live-label')).animationName;
  expect(changed).toContain('bs-thinking-shimmer');
  expect(changed).toContain('bs-trace-label-enter');
});

test('collapsed activity releases display subscriptions and restores manual detail state with the latest output', async () => {
  const listeners = new Set<() => void>();
  let value = 0;
  let callbacks = 0;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getSnapshot = (): number => value;
  function SubscribedDetail() {
    const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [expanded, setExpanded] = useState(false);
    return (
      <button
        aria-expanded={expanded}
        data-value={current}
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        Tool detail
      </button>
    );
  }
  render(
    <ActivityTrace
      detail={null}
      fallbackMs={undefined}
      incompleteReason={undefined}
      isActive={false}
      restingOverride={null}
      summary={done}
    >
      <SubscribedDetail />
    </ActivityTrace>
  );
  await waitFor(() => expect(listeners.size).toBe(0));
  fireEvent.click(screen.getByRole('button', { name: 'Expand activity' }));
  const detail = await screen.findByRole('button', { name: 'Tool detail' });
  await waitFor(() => expect(listeners.size).toBe(1));
  fireEvent.click(detail);
  expect(detail).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Collapse activity' }));
  await waitFor(() => expect(listeners.size).toBe(0));
  for (let index = 1; index <= 20; index++) {
    value = index;
    for (const listener of listeners) {
      callbacks++;
      listener();
    }
  }
  expect(callbacks).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Expand activity' }));
  expect(await screen.findByRole('button', { name: 'Tool detail' })).toBe(detail);
  expect(detail).toHaveAttribute('aria-expanded', 'true');
  expect(detail).toHaveAttribute('data-value', '20');
});

test('a streamed effect owner preserves sibling disclosure state and DOM as ownership changes', async () => {
  function Detail({ output }: { output: string }) {
    const [expanded, setExpanded] = useState(false);
    return (
      <button
        aria-expanded={expanded}
        data-output={output}
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        Sibling detail
      </button>
    );
  }
  const row = (preserveBodyEffects: boolean, output: string) => (
    <ActivityTrace
      detail={null}
      fallbackMs={undefined}
      incompleteReason={undefined}
      isActive
      preserveBodyEffects={preserveBodyEffects}
      restingOverride={null}
      summary={live}
    >
      <Detail output={output} />
    </ActivityTrace>
  );
  const view = render(row(false, 'Waiting for result'));
  fireEvent.click(screen.getByRole('button', { name: 'Expand activity' }));
  const detail = await screen.findByRole('button', { name: 'Sibling detail' });
  fireEvent.click(detail);
  expect(detail).toHaveAttribute('aria-expanded', 'true');
  view.rerender(row(true, 'App result arrived'));
  expect(await screen.findByRole('button', { name: 'Sibling detail' })).toBe(detail);
  expect(detail).toHaveAttribute('aria-expanded', 'true');
  expect(detail).toHaveAttribute('data-output', 'App result arrived');
  fireEvent.click(screen.getByRole('button', { name: 'Collapse activity' }));
  view.rerender(row(true, 'App output progressed'));
  await waitFor(() => expect(detail).toHaveAttribute('data-output', 'App output progressed'));
  expect(view.container.querySelector('button[data-output]')).toBe(detail);
  expect(detail).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByTestId('assistant-activity-body')).toHaveAttribute('hidden');
  fireEvent.click(screen.getByRole('button', { name: 'Expand activity' }));
  view.rerender(row(false, 'Ordinary result restored'));
  expect(await screen.findByRole('button', { name: 'Sibling detail' })).toBe(detail);
  expect(detail).toHaveAttribute('aria-expanded', 'true');
});
