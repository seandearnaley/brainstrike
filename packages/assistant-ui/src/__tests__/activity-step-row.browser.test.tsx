// The browser lane loads `@brainstrike/ui/globals.css` and `overrides.css`
// only — no Tailwind utilities. `sr-only` (used for the row's hidden tool-id
// span) is a Tailwind utility class here with no matching rule, so it does
// NOT hide anything in this lane: a `toolName` prop renders its text
// visibly. Pass `toolName` in a browser test only if the assertion accounts
// for that visible text; none of the tests below pass it.
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { StepRowHeader } from '../activity-step-row';
import { AssistantThinkingIndicator } from '../assistant-thinking-indicator';

function px(value: string): number {
  return Number.parseFloat(value);
}

/**
 * Like `container.querySelector`, but throws a readable error instead of
 * handing back `null` disguised as an element via an `as` cast. Typed as
 * `Element` (not `HTMLElement`) so it also matches SVG nodes — the chevron's
 * geometry class lands on the `<svg>` itself, which is an `SVGElement`.
 */
function mustFind(container: ParentNode, selector: string): Element {
  const el = container.querySelector(selector);
  if (el === null) {
    throw new Error(`mustFind: no element matched "${selector}"`);
  }
  return el;
}

test('a very long target keeps the timing slot and glyph inside the row, on one line', () => {
  const longTarget = 'a'.repeat(300);
  const { container } = render(
    <div className="assistant-ui-panel" style={{ width: 480 }}>
      <div className="bs-step-list">
        <StepRowHeader
          bodyId="body-1"
          expanded={false}
          family="read"
          label="Expand details"
          onToggle={() => {}}
          state="done"
          target={longTarget}
          timing="1.2s"
          verb="Read"
        />
      </div>
    </div>
  );
  const panel = mustFind(container, '.assistant-ui-panel');
  const row = mustFind(container, '[data-testid="activity-step-row"]');
  const target = mustFind(row, '.bs-step-row-target');
  const timing = mustFind(row, '.bs-step-row-timing');
  const glyph = mustFind(row, '.bs-step-glyph');
  const rowRect = row.getBoundingClientRect();

  expect(rowRect.height).toBeLessThan(40);
  // The 480px panel never grows a horizontal overflow — the target chip is
  // the only element allowed to shrink, not the row around it.
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  // Truncated (ellipsis), not merely clipped to zero: scrollWidth exceeds
  // clientWidth only when the box is actually narrower than its text.
  expect(target.scrollWidth).toBeGreaterThan(target.clientWidth);
  expect(timing.getBoundingClientRect().right).toBeLessThanOrEqual(rowRect.right + 0.5);
  expect(glyph.getBoundingClientRect().right).toBeLessThanOrEqual(rowRect.right + 0.5);
});

/*
 * BST-849's rule, restated for the step row: the RUNNING timing slot shrinks
 * (the settled duration does not). Its live label — "Receiving input · 999.9
 * KB · 9m 59s" and longer — is unbounded at the call site, so a slot that
 * cannot shrink pushes the row past its list and squeezes the target chip out.
 * The geometry is stylesheet-owned (`.bs-step-row-timing`, overrides.css), not
 * the indicator's `max-w-[60%]` utility: that percentage resolves against the
 * timing box's own width, so it can never bound the box that contains it — and
 * the browser lane, which loads no Tailwind, would not see it at all.
 */
test('the running timing slot shrinks to 60% of the row and truncates, instead of widening the row', () => {
  const { container } = render(
    <div className="assistant-ui-panel" style={{ width: 480 }}>
      <div className="bs-step-list">
        <StepRowHeader
          bodyId="body-1"
          expanded={false}
          family="read"
          label="Expand details"
          onToggle={() => {}}
          state="running"
          target={'d'.repeat(120)}
          timing={
            <AssistantThinkingIndicator
              className="text-xs tabular-nums"
              label="Receiving input · 999.9 KB · 9m 59s · an extra long live progress label that must truncate"
              // The row's state glyph already carries the live mark.
              showMark={false}
              textClassName="truncate"
            />
          }
          // A clamped-but-unshrinkable meta chip beside it: 60% is the slot's
          // CEILING, not its size. With a 9rem chip in the row the label has
          // to give up more than 40% for the row to fit, which is what
          // `flex: 0 1 auto` (rather than `flex-shrink: 0`) buys.
          trailing={<span className="bs-step-row-meta">read {'x'.repeat(80)} lines</span>}
          verb="Reading"
        />
      </div>
    </div>
  );
  const panel = mustFind(container, '.assistant-ui-panel');
  const row = mustFind(container, '[data-testid="activity-step-row"]');
  const timing = mustFind(row, '.bs-step-row-timing');
  const rowStyle = getComputedStyle(row);
  const rowContentWidth = row.clientWidth - px(rowStyle.paddingLeft) - px(rowStyle.paddingRight);

  const meta = mustFind(row, '.bs-step-row-meta');

  // One line, and the 480px panel never grows a horizontal overflow.
  expect(row.getBoundingClientRect().height).toBeLessThan(40);
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  expect(timing.clientWidth).toBeLessThanOrEqual(0.6 * rowContentWidth + 0.5);
  // Truncated, not clipped to nothing: the box is narrower than its label.
  expect(timing.scrollWidth).toBeGreaterThan(timing.clientWidth);
  // The slot yields real space rather than parking at its 60% ceiling: an
  // unshrinkable slot leaves the content span too narrow for the meta chip,
  // which — the span's overflow is visible, so nothing clips or scrolls it —
  // simply runs UNDER the timing label. Nothing else in this row measures
  // that collision.
  expect(meta.getBoundingClientRect().right).toBeLessThanOrEqual(
    timing.getBoundingClientRect().left + 0.5
  );
});

/*
 * The other half of the same rule, and the reason `max-inline-size: 60%` is a
 * separate guard from `flex: 0 1 auto`: shrinking only bounds the slot while
 * something else is competing for the row. Give the row a SHORT target and the
 * flex algorithm happily hands the long live label most of the width, burying
 * the one identifier that says which file is being read. 60% is the ceiling
 * that keeps the target legible whatever the label says.
 */
test('the running label is capped at 60% of the row even when nothing else competes for the space', () => {
  const { container } = render(
    <div className="assistant-ui-panel" style={{ width: 480 }}>
      <div className="bs-step-list">
        <StepRowHeader
          family="read"
          label="Read"
          state="running"
          target="src/app.ts"
          timing={
            <AssistantThinkingIndicator
              className="text-xs tabular-nums"
              label={`Receiving input · 999.9 KB · 9m 59s · ${'a live progress label with no natural bound '.repeat(4)}`}
              showMark={false}
              textClassName="truncate"
            />
          }
          verb="Reading"
        />
      </div>
    </div>
  );
  const row = mustFind(container, '[data-testid="activity-step-row"]');
  const timing = mustFind(row, '.bs-step-row-timing');
  const target = mustFind(row, '.bs-step-row-target');
  const rowStyle = getComputedStyle(row);
  const rowContentWidth = row.clientWidth - px(rowStyle.paddingLeft) - px(rowStyle.paddingRight);

  expect(timing.clientWidth).toBeLessThanOrEqual(0.6 * rowContentWidth + 0.5);
  // The target is still fully readable, not shrunk to an ellipsis.
  expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth);
});

test('the non-interactive form (div role=group) owns its own box model without a UA button sheet to fall back on', () => {
  const longTarget = 'b'.repeat(300);
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list" style={{ width: 240 }}>
        <StepRowHeader family="read" label="Read" state="done" target={longTarget} verb="Read" />
      </div>
    </div>
  );
  const list = mustFind(container, '.bs-step-list');
  const row = mustFind(container, '[data-testid="activity-step-row"]');
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
    list.getBoundingClientRect().right + 0.5
  );
});

test('a trailing meta chip is clamped and ellipsised, never an unbounded flex item', () => {
  // The root-name chip ("in <rootName>") comes from tool RESULT data, so its
  // length is not ours to bound at the call site. `.bs-step-row-meta` does not
  // shrink, so without a max size one long root name pushes the row's own
  // scrollWidth past the list.
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list" style={{ width: 320 }}>
        <StepRowHeader
          family="read"
          label="Read"
          state="done"
          target={null}
          trailing={<span className="bs-step-row-meta">in {'x'.repeat(80)}</span>}
          verb="Read"
        />
      </div>
    </div>
  );
  const list = mustFind(container, '.bs-step-list');
  const meta = mustFind(container, '.bs-step-row-meta');
  // 9rem === the `max-w-36` the pre-BST-1681 header carried.
  expect(meta.getBoundingClientRect().width).toBeLessThanOrEqual(9 * 16 + 0.5);
  // Truncated, not merely clipped to nothing.
  expect(meta.scrollWidth).toBeGreaterThan(meta.clientWidth);
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
});

test('a sibling control in .bs-step-row-line keeps its own width; the row never squeezes it out', () => {
  const longTarget = 'c'.repeat(300);
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list" style={{ width: 240 }}>
        <div className="bs-step-row-line">
          <StepRowHeader
            bodyId="body-1"
            expanded={false}
            family="read"
            label="Expand details"
            onToggle={() => {}}
            state="done"
            target={longTarget}
            verb="Read"
          />
          <button data-testid="sibling-control" style={{ width: 32 }} type="button">
            x
          </button>
        </div>
      </div>
    </div>
  );
  const line = mustFind(container, '.bs-step-row-line');
  const sibling = mustFind(container, '[data-testid="sibling-control"]');
  expect(sibling.getBoundingClientRect().width).toBeCloseTo(32, 0);
  expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
});

test("the chevron's box is stylesheet-owned, not left to the size-3.5 utility alone", () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list">
        <StepRowHeader
          bodyId="body-1"
          expanded={false}
          family="read"
          label="Expand details"
          onToggle={() => {}}
          state="done"
          target={null}
          verb="Read"
        />
      </div>
    </div>
  );
  const chevron = mustFind(container, '.bs-step-row-chevron');
  expect(chevron.getBoundingClientRect().width).toBeCloseTo(14, 0);
});

/*
 * The row is NEVER a direct child of `.bs-step-list` in production: every step
 * is wrapped by `ActivityPartLayout`'s div (one level), and `ToolFallback`
 * nests its row two levels deeper still (`.bs-tool-timeline` >
 * `.bs-step-row-line`). So `--bs-stagger` is set on the WRAPPER by the
 * `:nth-child` rules and reaches the row only by INHERITANCE — which a
 * `--bs-stagger: 0` declaration on `.bs-trace-reveal` itself would shadow on
 * every row. Rendering the rows as direct children (as this test first did)
 * hid exactly that: it is the one shape the real tree never has.
 */
test('the reveal stagger is positional: nth-child index sets --bs-stagger on the wrapper, the nested row inherits it, capped at 5', () => {
  // Seven wrappers so the nth-child(n + 6) cap rule (row 7 onward) is
  // exercised, not just its first trigger (row 6).
  const rows = Array.from({ length: 7 }, (_, index) => index + 1);
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list">
        {rows.map((n) =>
          // Wrapper 3 mirrors ToolFallback: the row sits two levels below the
          // list child, not one.
          n === 3 ? (
            <div key={n}>
              <div className="bs-step-row-line">
                <StepRowHeader
                  family="read"
                  label={`Row ${n}`}
                  state="done"
                  target={null}
                  verb={`Row ${n}`}
                />
              </div>
            </div>
          ) : (
            <div key={n}>
              <StepRowHeader
                family="read"
                label={`Row ${n}`}
                state="done"
                target={null}
                verb={`Row ${n}`}
              />
            </div>
          )
        )}
      </div>
    </div>
  );
  const rowEls = Array.from(container.querySelectorAll('[data-testid="activity-step-row"]'));
  // 1-based, matching nth-child.
  const delay = (rowNumber: number) => {
    const el = rowEls[rowNumber - 1];
    if (el === undefined) {
      throw new Error(`unreachable: no row rendered at position ${rowNumber}`);
    }
    return px(getComputedStyle(el).animationDelay) * 1000;
  };

  expect(rows.map((n) => delay(n))).toEqual([0, 40, 80, 120, 160, 200, 200]);
});

/*
 * Task 5 left `.bs-activity-body`'s `gap: 0.25rem` with a single child
 * (`.bs-step-list`), so the 0.75rem rhythm between step rows collapsed to
 * `ActivityPartLayout`'s `mb-2` alone. The list must stay a BLOCK container
 * (the `.bs-step-row` `width: 100%` / `flex: 1 1 0%` geometry above depends on
 * it), so the rhythm is restored with a margin on the wrappers instead of a
 * flex gap. The wrappers carry `margin-bottom: 0.5rem` inline here because
 * `mb-2` is a Tailwind utility this lane cannot see.
 */
test('two step rows in the list sit 12px apart, the pre-Task-5 rhythm', () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list" style={{ width: 320 }}>
        <div data-testid="wrapper-1" style={{ marginBottom: '0.5rem' }}>
          <StepRowHeader family="read" label="Read" state="done" target={null} verb="Read" />
        </div>
        <div data-testid="wrapper-2" style={{ marginBottom: '0.5rem' }}>
          <StepRowHeader family="read" label="Read" state="done" target={null} verb="Read" />
        </div>
      </div>
    </div>
  );
  const first = mustFind(container, '[data-testid="wrapper-1"]').getBoundingClientRect();
  const second = mustFind(container, '[data-testid="wrapper-2"]').getBoundingClientRect();
  expect(second.top - first.bottom).toBeCloseTo(12, 0);
});

/*
 * The exception to the rhythm above. At Developer detail the run-event rows
 * are direct children of `.bs-step-list` too (verified against the real
 * runtime, not assumed), and they are quiet single-line rows meant to read as
 * ONE block rather than as separated cards. They carry no wrapper margin of
 * their own, so the blanket step rhythm would space them out like tool cards.
 */
test('consecutive run-event rows in the list stay tight, not on the step rhythm', () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list" style={{ width: 320 }}>
        <div data-testid="wrapper-1" style={{ marginBottom: '0.5rem' }}>
          <StepRowHeader family="read" label="Read" state="done" target={null} verb="Read" />
        </div>
        <div className="bs-run-timeline" data-testid="run-1">
          run event one
        </div>
        <div className="bs-run-timeline" data-testid="run-2">
          run event two
        </div>
      </div>
    </div>
  );
  const first = mustFind(container, '[data-testid="run-1"]').getBoundingClientRect();
  const second = mustFind(container, '[data-testid="run-2"]').getBoundingClientRect();
  expect(second.top - first.bottom).toBeCloseTo(4, 0);
});
