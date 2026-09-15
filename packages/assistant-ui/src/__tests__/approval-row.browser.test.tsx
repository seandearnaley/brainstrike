// The browser lane loads `@brainstrike/ui/globals.css` and `overrides.css`
// only — the rail colour and row geometry must come from those two files.
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { afterEach, expect, test } from 'vitest';
import { ApprovalRails } from '../approval-rails';
import { mustFind } from './browser-dom';

const path = [
  {
    childRuntimeRunId: 'child-run-1',
    parentRuntimeRunId: 'root-run',
    parentToolCallId: 'delegate-1',
    personaId: 'explore',
  },
  {
    childRuntimeRunId: 'grandchild-run-1',
    parentRuntimeRunId: 'child-run-1',
    parentToolCallId: 'delegate-1-1',
    personaId: 'analyze',
  },
];

afterEach(() => {
  document.documentElement.classList.remove('dark');
  document.body.replaceChildren();
});

function renderRails(): HTMLElement {
  const { container } = render(
    <div className="assistant-ui-panel">
      <div
        className="bs-approval bs-approval-row"
        style={{ '--bs-approval-depth': 2 } as CSSProperties}
      >
        <ApprovalRails path={path} />
      </div>
    </div>
  );
  return container;
}

test('each ancestor rail paints its own delegation token, and the token flips with the theme', () => {
  const light = renderRails();
  const rails = light.querySelectorAll('.bs-approval-rail');
  expect(rails).toHaveLength(2);
  const lightColours = [...rails].map((rail) => getComputedStyle(rail).backgroundColor);
  expect(lightColours[0]).toMatch(/^rgb\(/);
  // Two distinct edges may hash to the same hue; the assertion that matters
  // is that each rail resolved a REAL colour, not `rgba(0, 0, 0, 0)`.
  expect(lightColours.every((colour) => colour !== 'rgba(0, 0, 0, 0)')).toBe(true);

  document.body.replaceChildren();
  document.documentElement.classList.add('dark');
  const dark = renderRails();
  const darkColours = [...dark.querySelectorAll('.bs-approval-rail')].map(
    (rail) => getComputedStyle(rail).backgroundColor
  );
  // The dark palette lifts every hue, so the same rail never paints the same
  // colour in both themes (a token defined only on :root would).
  expect(darkColours[0]).not.toBe(lightColours[0]);
  expect(darkColours[1]).not.toBe(lightColours[1]);
});

test('depth indents the surface by 1.25rem per level', () => {
  const container = renderRails();
  const surface = mustFind(container, '.bs-approval');
  expect(getComputedStyle(surface).marginInlineStart).toBe('40px');
});
