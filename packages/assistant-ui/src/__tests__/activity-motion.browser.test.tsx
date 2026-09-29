import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

function px(value: string): number {
  return Number.parseFloat(value);
}

// Deviation from the task brief's literal test body (documented in the task
// report): reading `gridTemplateRows` synchronously, in the same tick as the
// `data-open` toggle, returns the PRE-transition value (0px), not the target —
// standard CSS Transitions timeline semantics (the animated value is pinned
// to its start keyframe until at least one rendering opportunity elapses),
// confirmed here against a plain `opacity` transition too, not specific to
// `grid-template-rows`. So the test polls until the transition settles
// (`vi.waitFor`, bounded well above the declared 220ms) instead of sleeping a
// hard-coded margin that a loaded CI runner could overrun.
test('grid-rows disclosure opens to content height and closes to zero, with a transition declared', async () => {
  const { container, rerender } = render(
    <div className="assistant-ui-panel">
      <div className="bs-trace-collapse" data-open="false" data-testid="collapse">
        <div className="bs-trace-collapse-inner">
          <div style={{ height: 40 }} />
        </div>
      </div>
    </div>
  );
  const collapse = container.querySelector('[data-testid="collapse"]') as HTMLElement;
  expect(getComputedStyle(collapse).gridTemplateRows).toBe('0px');
  rerender(
    <div className="assistant-ui-panel">
      <div className="bs-trace-collapse" data-open="true" data-testid="collapse">
        <div className="bs-trace-collapse-inner">
          <div style={{ height: 40 }} />
        </div>
      </div>
    </div>
  );
  await vi.waitFor(
    () => expect(px(getComputedStyle(collapse).gridTemplateRows)).toBeGreaterThanOrEqual(40),
    { interval: 20, timeout: 2000 }
  );
  expect(getComputedStyle(collapse).transitionProperty).toContain('grid-template-rows');
});

test('reveal rows carry a bounded stagger delay', () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      {[0, 1, 7].map((index) => (
        <div
          className="bs-trace-reveal"
          data-testid={`row-${index}`}
          key={index}
          style={{ ['--bs-stagger' as string]: String(index) }}
        />
      ))}
    </div>
  );
  const delay = (index: number) =>
    px(
      getComputedStyle(container.querySelector(`[data-testid="row-${index}"]`) as HTMLElement)
        .animationDelay
    ) * 1000;
  expect(delay(0)).toBe(0);
  expect(delay(1)).toBeGreaterThan(0);
  expect(delay(7)).toBe(delay(1) * 5);
});

test('the detail slot has a fixed one-line height', () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-trace-detail" data-testid="detail" />
    </div>
  );
  const detail = container.querySelector('[data-testid="detail"]') as HTMLElement;
  expect(px(getComputedStyle(detail).height)).toBeGreaterThan(0);
  expect(getComputedStyle(detail).overflow).toBe('hidden');
});
