import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { AssistantActivityGroup } from '../assistant-ui-panel/assistant-activity-group';
import type { ToolActivitySummary } from '../assistant-ui-panel/tool-activity';
// Theme variables (colors, shimmer, tints) so screenshots render faithfully.
import '../globals.css';
import '../assistant-ui-panel/overrides.css';

/**
 * Reproduce the real app's CSS baseline: Tailwind v4 preflight zeroes element
 * margins and strips list styling via a universal-selector reset. The markdown
 * typography fix must win over this (it does — its selectors out-specify the
 * universal reset), which is exactly what these real-Chromium assertions prove.
 */
const PREFLIGHT_RESET = `
  *, ::before, ::after { margin: 0; padding: 0; }
  ul, ol { list-style: none; }
`;

beforeAll(() => {
  const style = document.createElement('style');
  style.id = 'preflight-reset';
  style.textContent = PREFLIGHT_RESET;
  document.head.prepend(style);
});

afterEach(() => {
  document.body.replaceChildren();
});

const activeSummary: ToolActivitySummary = {
  activeArg: 'packages/db/src/registry.ts',
  activeLabel: 'brainstrike.grepSearch',
  failedCount: 0,
  runningCount: 1,
  stepCount: 3,
};

const doneSummary: ToolActivitySummary = {
  activeArg: null,
  activeLabel: null,
  failedCount: 0,
  runningCount: 0,
  stepCount: 5,
};

describe('markdown typography (real browser, with preflight reset)', () => {
  test('restores paragraph, list, and heading spacing that preflight removed', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="aui-md">
          <p data-testid="p1">First paragraph.</p>
          <p data-testid="p2">Second paragraph should be visually separated.</p>
          <ul>
            <li data-testid="li1">bullet one</li>
            <li>bullet two</li>
          </ul>
          <h2 data-testid="h2">A heading</h2>
        </div>
      </div>
    );

    const secondParagraph = screen.getByTestId('p2');
    const list = secondParagraph.parentElement?.querySelector('ul');
    const listItem = screen.getByTestId('li1');
    const heading = screen.getByTestId('h2');

    // The bug: bare <p> fell through to preflight margin:0 → cramped.
    // The fix: a non-zero vertical margin separates paragraphs again.
    const pMarginTop = Number.parseFloat(getComputedStyle(secondParagraph).marginTop);
    expect(pMarginTop).toBeGreaterThan(0);

    // Preflight strips list-style + indent; the fix restores both.
    if (!list) {
      throw new Error('expected a <ul> inside the markdown body');
    }
    expect(getComputedStyle(list).listStyleType).toBe('disc');
    expect(Number.parseFloat(getComputedStyle(list).paddingLeft)).toBeGreaterThan(0);
    expect(Number.parseFloat(getComputedStyle(listItem).marginTop)).toBeGreaterThan(0);

    // Headings regain weight and vertical breathing room.
    expect(getComputedStyle(heading).fontWeight).toBe('600');
    expect(Number.parseFloat(getComputedStyle(heading).marginTop)).toBeGreaterThan(0);
  });

  test('first child has no leading margin (no double gap above the answer)', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="aui-md">
          <p data-testid="first">Leading paragraph.</p>
        </div>
      </div>
    );
    expect(getComputedStyle(screen.getByTestId('first')).marginTop).toBe('0px');
  });

  test('styles the bare fallback code block (Shiki loading/failure) with a container', () => {
    render(
      <div className="assistant-ui-panel">
        <div className="aui-md">
          <pre data-testid="fallback-pre">
            <code>const x = 1;</code>
          </pre>
        </div>
      </div>
    );
    const pre = screen.getByTestId('fallback-pre');
    // A real container: non-zero padding + a non-transparent background.
    expect(Number.parseFloat(getComputedStyle(pre).paddingTop)).toBeGreaterThan(0);
    expect(getComputedStyle(pre).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(pre).overflowX).toBe('auto');
  });
});

describe('AssistantActivityGroup (real browser)', () => {
  test('active turn: live "Working" heartbeat, current tool, expanded body', () => {
    render(
      <div className="assistant-ui-panel">
        <AssistantActivityGroup isActive summary={activeSummary}>
          <div data-testid="tool-rows">tool rows</div>
        </AssistantActivityGroup>
      </div>
    );

    expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent('Working');
    expect(screen.getByText(/brainstrike\.grepSearch/)).toBeVisible();
    expect(screen.getByText(/registry\.ts/)).toBeVisible();
    expect(screen.getByTestId('assistant-activity-body')).toBeVisible();

    // The panel chrome actually rendered (CSS applied in a real browser).
    const group = screen.getByTestId('assistant-activity-group');
    expect(group).toHaveAttribute('data-active', 'true');
    expect(Number.parseFloat(getComputedStyle(group).borderRadius)).toBeGreaterThan(0);
  });

  test('done turn: auto-collapsed summary that expands on click', async () => {
    const user = userEvent.setup();
    render(
      <div className="assistant-ui-panel">
        <AssistantActivityGroup fallbackMs={12_000} isActive={false} summary={doneSummary}>
          <div data-testid="tool-rows">tool rows</div>
        </AssistantActivityGroup>
      </div>
    );

    expect(screen.getByText('Worked')).toBeVisible();
    expect(screen.getByText(/for 12\.0s/)).toBeVisible();
    expect(screen.getByText(/5 steps/)).toBeVisible();

    // Auto-collapsed when done: the body is hidden (display:none via [hidden]).
    const body = screen.getByTestId('assistant-activity-body');
    expect(body).not.toBeVisible();

    // User can expand it.
    await user.click(screen.getByTestId('assistant-activity-summary'));
    expect(body).toBeVisible();
  });

  test('failed turn renders the failed treatment', () => {
    render(
      <div className="assistant-ui-panel">
        <AssistantActivityGroup isActive={false} summary={{ ...doneSummary, failedCount: 2 }} />
      </div>
    );
    const group = screen.getByTestId('assistant-activity-group');
    expect(group).toHaveAttribute('data-failed', 'true');
    expect(screen.getByText('Activity failed')).toBeVisible();
  });
});
