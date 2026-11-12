import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { act } from '@brainstrike/test-utils/react-act';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { expect, test } from 'vitest';
import { ActivityTrace } from '../activity-trace';
import { SubagentChip } from '../subagent-chip';
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
// boundary — the live tail is added and removed wholesale — which is the
// documented design, not a regression (review finding 7).
test('the status row (summary button) keeps one height across live and resting states; the live tail below it is added/removed at the boundary', () => {
  const { rerender } = render(
    <div className="assistant-ui-panel">
      <ActivityTrace
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={live}
        tail={[{ family: 'read', id: 'call-1', state: 'done', target: 'src/app.ts', verb: 'Read' }]}
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
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
        tail={[]}
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
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={isActive}
        restingOverride={null}
        summary={summary}
        tail={[]}
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

test('the live tail renders only while active and the chevron rotates when open', async () => {
  render(
    <div className="assistant-ui-panel">
      <ActivityTrace
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={live}
        tail={[{ family: 'read', id: 'call-1', state: 'done', target: 'src/app.ts', verb: 'Read' }]}
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
        fallbackMs={12_000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={headline}
        summary={summary}
        tail={[]}
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

test('subagent chips keep the header on one line, folding to their colour dots where their names do not fit', () => {
  const callSigns = ['Cedar-a9b0a8', 'Nimbus-54e4c0', 'Iris-35a412'];
  const resting = 'Updated memory, loaded tool, delegated to Worker';
  const summary = {
    counts: { failed: 1, steps: 28 },
    live: 'Working',
    resting,
    verbs: resting,
    waiting: false,
  };
  const marks = Array.from({ length: 28 }, (_, index) => ({
    kind: 'read' as const,
    label: `Step ${index}`,
    stepId: `step-${index}`,
  }));
  const header = (width: number, agents: readonly string[]) => (
    <div className="assistant-ui-panel" style={{ width }}>
      <ActivityTrace
        {...(agents.length > 0
          ? {
              agents: agents.map((callSign) => (
                <SubagentChip
                  agent={{ callSign, colorId: 'family:180:500', onOpen: () => undefined }}
                  key={callSign}
                />
              )),
            }
          : {})}
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        onShowFailed={() => undefined}
        restingOverride={null}
        strip={{ marks, onPick: () => undefined }}
        summary={summary}
        tail={[]}
      />
    </div>
  );
  const headerBox = () => mustFind(document.body, '.bs-activity-header').getBoundingClientRect();
  const chipHeights = new Set<number>();

  for (const width of [400, 900]) {
    const { rerender, unmount } = render(header(width, []));
    const oneLine = headerBox().height;
    rerender(header(width, callSigns));
    const row = headerBox();
    expect(row.height).toBe(oneLine);
    // The controls after the headline sit inside the row, in order, apart.
    const controls = [
      screen.getByTestId('assistant-activity-failed-count'),
      ...screen.getAllByTestId('subagent-chip'),
      screen.getByTestId('assistant-activity-run-strip'),
    ]
      .map((control) => control.getBoundingClientRect())
      .filter((box) => box.width > 0);
    for (const [index, box] of controls.entries()) {
      expect(box.left).toBeGreaterThanOrEqual(row.left);
      expect(box.right).toBeLessThanOrEqual(row.right);
      const next = controls[index + 1];
      if (next) {
        expect(next.left).toBeGreaterThan(box.right);
      }
    }
    for (const callSign of callSigns) {
      // Folded or not, each chip is still named and still opens its subagent.
      const chip = screen.getByRole('button', { name: `Go to ${callSign}` });
      const label = screen.getByText(callSign).getBoundingClientRect();
      const box = chip.getBoundingClientRect();
      chipHeights.add(box.height);
      if (width === 400) {
        expect(box.width).toBe(box.height);
        expect(label.width).toBeLessThanOrEqual(1);
      } else {
        expect(label.width).toBeGreaterThan(40);
      }
    }
    unmount();
  }
  // A folded dot is exactly as tall as a named chip.
  expect(chipHeights.size).toBe(1);
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
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={headline}
        summary={done}
        tail={[]}
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
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
        tail={[]}
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
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={headline}
        summary={done}
        tail={[]}
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
 * The live label's entrance and its shimmer are separate animations on
 * separate boxes: the label enters when its wording changes, and the shimmer
 * is the band inside it, sweeping from the first paint. (They once shared the
 * label, where the shimmer's `animation` shorthand replaced the entrance.)
 */
test('the live label enters only once its wording changes, and its shimmer band sweeps from the first paint', () => {
  const row = (liveLabel: string) => (
    <div className="assistant-ui-panel">
      <ActivityTrace
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={{ ...live, live: liveLabel }}
        tail={[]}
      />
    </div>
  );
  const animationOf = (selector: string): string =>
    getComputedStyle(mustFind(container, selector)).animationName;
  const { container, rerender } = render(row('Reading app.ts'));
  expect(animationOf('.bs-activity-live-label')).toBe('none');
  expect(animationOf('.bs-thinking-shimmer-band')).toBe('bs-thinking-shimmer-band');

  rerender(row('Editing app.ts'));
  expect(animationOf('.bs-activity-live-label')).toBe('bs-trace-label-enter');
  expect(animationOf('.bs-thinking-shimmer-band')).toBe('bs-thinking-shimmer-band');
  // The band's copy is the label's text, and only the label's own text is read.
  const label = mustFind(container, '.bs-activity-live-label');
  expect(label).toHaveTextContent('Editing app.ts');
  expect(getComputedStyle(mustFind(label, '.bs-thinking-shimmer-band'), '::before').content).toBe(
    '"Editing app.ts"'
  );
});

/*
 * A run in flight shows its mark and its shimmering label for as long as it
 * lasts: minutes, for an agent working through tools. Chromium animates an
 * HTML box's transform and opacity on the compositor; anything else (an
 * element inside an SVG, a `background-position`) it restyles, lays out and
 * paints on the main thread on every frame. Measured in the built app, a run
 * that was only waiting kept the main thread 22% busy until its indicators
 * moved to HTML boxes.
 */
test('every animation of a running activity header is a transform or opacity on an HTML box', async () => {
  render(
    <div className="assistant-ui-panel">
      <ActivityTrace
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive
        restingOverride={null}
        summary={live}
        tail={[]}
      />
    </div>
  );
  const header = screen.getByTestId('assistant-activity-summary');
  await waitFor(() => expect(header.getAnimations({ subtree: true }).length).toBeGreaterThan(3));
  const running = header
    .getAnimations({ subtree: true })
    .filter(
      (animation) => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY
    );
  const mainThreadOnly = running.flatMap((animation) => {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect && effect.target)) {
      return ['an animation with no target'];
    }
    const properties = [
      ...new Set(
        effect
          .getKeyframes()
          .flatMap((keyframe) => Object.keys(keyframe))
          .filter((key) => !['composite', 'computedOffset', 'easing', 'offset'].includes(key))
      ),
    ];
    const composited =
      effect.target instanceof HTMLElement &&
      properties.every((property) => property === 'opacity' || property === 'transform');
    return composited ? [] : [`<${effect.target.localName}> animates ${properties.join(', ')}`];
  });
  // Non-vacuous: the mark's rings and core and the label's band are all running.
  expect(running.length).toBeGreaterThan(3);
  expect(mainThreadOnly).toEqual([]);
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
      fallbackMs={undefined}
      incompleteReason={undefined}
      isActive={false}
      restingOverride={null}
      summary={done}
      tail={[]}
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
      fallbackMs={undefined}
      incompleteReason={undefined}
      isActive
      preserveBodyEffects={preserveBodyEffects}
      restingOverride={null}
      summary={live}
      tail={[]}
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

// BST-2200: a delegation card's "Open conversation" sits at the bottom of the
// opening body, so it is clipped while the grid rows animate. Whatever reveals
// a clipped control (keyboard focus, assistive technology, a test driver's
// click) calls scrollIntoView. When the clip was a scroll container it
// scrolled, and the rest of the transition slid the body back down under the
// pointer: the press landed on the button, the release on the task summary,
// and the conversation never opened. The clip must not move its content.
test('a control revealed in an opening activity body stays under the press for the rest of the transition', () => {
  render(
    <div className="assistant-ui-panel" style={{ width: 480 }}>
      <ActivityTrace
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
        tail={[]}
      >
        <div style={{ blockSize: 120 }}>Task summary</div>
        <button type="button">Open conversation</button>
      </ActivityTrace>
    </div>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Expand activity' }));
  const clip = mustFind(document, '.bs-trace-collapse-inner');
  const disclosure = mustFind(document, '.bs-trace-collapse');
  // Reading the style starts the open transition; hold it partway open.
  expect(getComputedStyle(disclosure).gridTemplateRows).toBe('0px');
  const [opening] = disclosure.getAnimations();
  if (!opening) {
    throw new Error('The activity body opened without its grid-rows transition.');
  }
  opening.pause();
  opening.currentTime = 20;
  const control = screen.getByRole('button', { name: 'Open conversation' });
  expect(control.getBoundingClientRect().bottom).toBeGreaterThan(
    clip.getBoundingClientRect().bottom
  );

  control.scrollIntoView({ block: 'nearest' });
  const pressedAt = control.getBoundingClientRect().top;
  expect(clip.scrollTop).toBe(0);
  opening.finish();

  expect(control.getBoundingClientRect().top).toBe(pressedAt);
});

// A step's target is one unbroken line (a tool id, a search query, a UUID).
// The disclosure is a grid, and an implicit grid column sizes to its widest
// child's content, so such a line widened the whole body past the group:
// nested cards ran out of the group's right edge and were cut off there.
test('a long unbroken line inside the activity body stays inside the group', () => {
  render(
    <div className="assistant-ui-panel" style={{ width: 480 }}>
      <ActivityTrace
        fallbackMs={1000}
        incompleteReason={undefined}
        isActive={false}
        restingOverride={null}
        summary={done}
        tail={[]}
      >
        <div data-testid="nested-card" style={{ border: '1px solid' }}>
          <span style={{ whiteSpace: 'nowrap' }}>
            {'brainstrike_readWorkspaceFile, '.repeat(20)}
          </span>
        </div>
      </ActivityTrace>
    </div>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Expand activity' }));
  const group = mustFind(document, '.bs-activity-group').getBoundingClientRect();
  const card = screen.getByTestId('nested-card').getBoundingClientRect();
  expect(card.right).toBeLessThanOrEqual(group.right);
});
