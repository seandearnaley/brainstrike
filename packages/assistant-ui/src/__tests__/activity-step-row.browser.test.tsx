import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { StepRowHeader } from '../activity-step-row';

function px(value: string): number {
  return Number.parseFloat(value);
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
  const panel = container.querySelector('.assistant-ui-panel') as HTMLElement;
  const row = container.querySelector('[data-testid="activity-step-row"]') as HTMLElement;
  const target = row.querySelector('.bs-step-row-target') as HTMLElement;
  const timing = row.querySelector('.bs-step-row-timing') as HTMLElement;
  const glyph = row.querySelector('.bs-step-glyph') as HTMLElement;
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

test('the reveal stagger is positional: nth-child index sets --bs-stagger, capped at 5', () => {
  // Seven rows so the nth-child(n + 6) cap rule (row 7 onward) is exercised,
  // not just its first trigger (row 6).
  const rows = Array.from({ length: 7 }, (_, index) => index + 1);
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-step-list">
        {rows.map((n) => (
          <StepRowHeader
            family="read"
            key={n}
            label={`Row ${n}`}
            state="done"
            target={null}
            verb={`Row ${n}`}
          />
        ))}
      </div>
    </div>
  );
  const rowEls = Array.from(container.querySelectorAll('[data-testid="activity-step-row"]'));
  // 1-based to match the brief's "rows 1, 2 and 7" (nth-child is 1-indexed).
  const delay = (rowNumber: number) => {
    const el = rowEls[rowNumber - 1];
    if (el === undefined) {
      throw new Error(`unreachable: no row rendered at position ${rowNumber}`);
    }
    return px(getComputedStyle(el).animationDelay) * 1000;
  };

  const oneStep = delay(2);
  expect(delay(1)).toBe(0);
  expect(oneStep).toBeGreaterThan(0);
  expect(delay(7)).toBe(oneStep * 5);
});
