// Browser lane loads the real shared palette and approval geometry.
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { afterEach, expect, test } from 'vitest';
import { ApprovalCard } from '../approval-card';
import { ApprovalRow } from '../approval-row';
import type { ApprovalNoticeState } from '../use-approval-notice-state';
import { mustFind } from './browser-dom';

const approval: AssistantToolApprovalRequest = {
  args: { path: 'apps/desktop' },
  delegation: {
    path: [
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
    ],
    toolCallId: 'leaf-deep',
  },
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
  sendError: null,
  status: 'Approved',
  submitApprovalAction: () => undefined,
};

afterEach(() => {
  document.documentElement.classList.remove('dark');
  document.body.replaceChildren();
});

function renderSurface(colorId?: string) {
  return render(
    <div
      className="assistant-ui-panel"
      data-agent-color="blue"
      style={
        {
          '--color-rose-500': '#f43f5e',
          '--color-sky-500': '#0ea5e9',
          '--color-violet-500': '#8b5cf6',
        } as CSSProperties
      }
    >
      <ApprovalRow approval={approval} colorId={colorId} state={state} />
      <ApprovalCard approval={approval} colorId={colorId} presentation="card" state={state} />
    </div>
  );
}

test('standalone approval row and card use the supplied owner color and retain depth', () => {
  const { container } = renderSurface('rose');
  const panel = mustFind(container, '.assistant-ui-panel');
  const row = mustFind(container, '.bs-approval-row') as HTMLElement;
  const card = mustFind(container, '[data-approval-presentation="card"]');
  const panelAccent = getComputedStyle(panel).getPropertyValue('--agent-accent').trim();
  const rowAccent = getComputedStyle(row).getPropertyValue('--agent-accent').trim();
  const cardAccent = getComputedStyle(card).getPropertyValue('--agent-accent').trim();

  expect(row).toHaveAttribute('data-agent-color', 'rose');
  expect(card).toHaveAttribute('data-agent-color', 'rose');
  expect(rowAccent).toBe(cardAccent);
  expect(rowAccent).not.toBe(panelAccent);
  expect(getComputedStyle(row).backgroundColor).toBe(getComputedStyle(card).backgroundColor);
  expect(getComputedStyle(row).marginInlineStart).toBe('40px');
  expect(getComputedStyle(card).marginInlineStart).toBe('40px');
  expect(getComputedStyle(row).borderInlineStartWidth).toBe('1px');
  expect(row.querySelectorAll('.bs-approval-rail')).toHaveLength(0);
  expect(card.querySelectorAll('.bs-approval-rail')).toHaveLength(0);
  expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
});

test('missing owner color inherits the current panel color in both themes', () => {
  const { container } = renderSurface();
  const panel = mustFind(container, '.assistant-ui-panel');
  const card = mustFind(container, '[data-approval-presentation="card"]');
  expect(card).not.toHaveAttribute('data-agent-color');
  expect(getComputedStyle(card).getPropertyValue('--agent-accent')).toBe(
    getComputedStyle(panel).getPropertyValue('--agent-accent')
  );
  const light = getComputedStyle(card).backgroundColor;
  document.documentElement.classList.add('dark');
  expect(getComputedStyle(card).backgroundColor).not.toBe(light);
});

test('expanded row owns color and depth; its embedded card adds neither', () => {
  const { container } = renderSurface('violet');
  fireEvent.click(screen.getByRole('button', { name: /show approval details/i }));
  const row = mustFind(container, '.bs-approval-row');
  const card = mustFind(row, '[data-testid="approval-row-card"]');
  expect(row).toHaveAttribute('data-agent-color', 'violet');
  expect(card).not.toHaveAttribute('data-agent-color');
  expect(card).not.toHaveClass('bs-approval');
  expect(getComputedStyle(card).marginInlineStart).toBe('0px');
  expect(getComputedStyle(card).getPropertyValue('--agent-accent')).toBe(
    getComputedStyle(row).getPropertyValue('--agent-accent')
  );
  const iconRow = mustFind(card, '[data-testid="approval-icon-row"]');
  expect(iconRow.childElementCount).toBe(1);
  expect(iconRow.firstElementChild?.tagName).toBe('svg');
});

test('family color paints both approval forms in light and dark while unresolved stays neutral', () => {
  const { container } = renderSurface('family:1375:540');
  const row = mustFind(container, '.bs-approval-row') as HTMLElement;
  const card = mustFind(container, '[data-approval-presentation="card"]');
  expect(row.style.getPropertyValue('--agent-accent-light')).toMatch(/^oklch\(/);
  expect(row.style.getPropertyValue('--agent-accent-dark')).toMatch(/^oklch\(/);
  expect(getComputedStyle(row).backgroundColor).toBe(getComputedStyle(card).backgroundColor);
  const light = getComputedStyle(row).backgroundColor;
  document.documentElement.classList.add('dark');
  expect(getComputedStyle(row).backgroundColor).not.toBe(light);

  document.body.replaceChildren();
  const unresolved = renderSurface('unresolved');
  const neutral = mustFind(unresolved.container, '.bs-approval-row') as HTMLElement;
  const panel = mustFind(unresolved.container, '.assistant-ui-panel');
  expect(neutral.style.getPropertyValue('--agent-accent-light')).toBe('');
  expect(getComputedStyle(neutral).getPropertyValue('--agent-accent')).not.toBe(
    getComputedStyle(panel).getPropertyValue('--agent-accent')
  );
});
