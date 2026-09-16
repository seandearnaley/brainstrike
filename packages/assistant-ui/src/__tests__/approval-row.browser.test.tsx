// The browser lane loads `@brainstrike/ui/globals.css` and `overrides.css`
// only — the rail colour and row geometry must come from those two files.
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { afterEach, expect, test } from 'vitest';
import { ApprovalRails } from '../approval-rails';
import { ApprovalRow } from '../approval-row';
import type { ApprovalNoticeState } from '../use-approval-notice-state';
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

test('an expanded row owns the indent and the rail: the embedded card adds neither', () => {
  const approval: AssistantToolApprovalRequest = {
    args: { path: 'apps/desktop' },
    delegation: { path, toolCallId: 'leaf-deep' },
    riskCategory: 'read',
    runId: 'root-run',
    toolCallId: 'delegate-1',
    toolName: 'brainstrike.readWorkspaceDirectory',
  };
  const state: ApprovalNoticeState = {
    actionButtonsDisabled: true,
    answered: true,
    decisionLocked: true,
    delegationOwner: null,
    hostAnswer: null,
    rediscovered: null,
    status: 'Approved',
    submitApprovalAction: () => undefined,
  };
  const { container } = render(
    <div className="assistant-ui-panel">
      <ApprovalRow approval={approval} state={state} />
    </div>
  );
  fireEvent.click(screen.getByRole('button', { name: /show approval details/i }));
  const row = getComputedStyle(mustFind(container, '.bs-approval-row'));
  const cardEl = mustFind(container, '[data-testid="approval-row-card"]');
  const card = getComputedStyle(cardEl);
  expect(row.marginInlineStart).toBe('40px');
  expect(row.borderInlineStartWidth).toBe('3px');
  expect(card.marginInlineStart).toBe('0px');
  // The rail needs BOTH halves of `.bs-approval[data-delegation-colour]`; the
  // base `.bs-approval` rule sets margin only. The class assertion names the
  // cause directly, and does not depend on the margin rule above continuing to
  // exist. The 0px covers what neither reaches: a rail arriving by some OTHER
  // route (a new selector, a `border-l-*` utility, an inline style) that never
  // touches `.bs-approval`. 0px rather than 1px because this lane loads no
  // Tailwind by design, per the banner above `.bs-approval` in overrides.css;
  // being a negative assertion it is the more stylesheet-sensitive of the two
  // literals here, so it is the one to revisit first if the lane ever gains
  // utilities. No claim about which of these fails first — for a re-added
  // surface the `card.marginInlineStart` assertion above trips before either.
  expect(card.borderInlineStartWidth).toBe('0px');
  expect(cardEl).not.toHaveClass('bs-approval');
  // The card now leans on `ApprovalRails` early-returning for an empty path
  // (the call site lost its length guard). If it ever emitted a wrapper
  // instead, that wrapper would become a second flex item and `gap-1.5` would
  // shove the warning icon 6px inward in every embedded approval — a
  // production consequence this lane cannot measure, since `gap-1.5` never
  // resolves here, so pin the structure it depends on instead. Identity as
  // well as count: `aria-hidden` is not unique forever, and a decorative node
  // added earlier with exactly one child would retarget this anchor and pass
  // both structural assertions vacuously.
  const iconRow = mustFind(cardEl, '[aria-hidden="true"]');
  expect(iconRow.querySelector('.bs-approval-rails')).toBeNull();
  expect(iconRow.childElementCount).toBe(1);
  expect(iconRow.firstElementChild?.tagName).toBe('svg');
});
