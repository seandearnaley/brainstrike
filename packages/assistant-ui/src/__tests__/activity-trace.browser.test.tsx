import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ActivityTrace } from '../activity-trace';

const live = { counts: { failed: 0, steps: 1 }, live: 'Reading app.ts', resting: 'Read' };
const done = { counts: { failed: 0, steps: 1 }, live: 'Working', resting: 'Read' };

test('the header keeps one height across live and resting states', () => {
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
  const liveHeight = screen
    .getByTestId('assistant-activity-summary')
    .getBoundingClientRect().height;
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
  const doneHeight = screen
    .getByTestId('assistant-activity-summary')
    .getBoundingClientRect().height;
  expect(Math.abs(liveHeight - doneHeight)).toBeLessThan(1);
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
