import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantDetailLevel } from '../assistant-detail-level';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
  useAssistantDetailLevel,
} from '../assistant-detail-level-context';
import { ToolFallback } from '../tool-fallback';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

const internalToolProps = {
  addResult: () => {},
  args: { query: 'foo' },
  argsText: '{"query":"foo"}',
  result: { matches: [{ a: 1 }, { a: 2 }, { a: 3 }] },
  resume: () => {},
  status: { type: 'complete' as const },
  toolCallId: 'call-internal-1',
  toolName: 'brainstrike.grepSearch',
  type: 'tool-call' as const,
};

function renderTool(props: Record<string, unknown>, level: AssistantDetailLevel) {
  window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, level);
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(
    <TooltipProvider>
      <AssistantDetailLevelProvider>
        <Comp {...props} />
      </AssistantDetailLevelProvider>
    </TooltipProvider>
  );
}

describe('ToolFallback detail level', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('compact shows the call only — no expander or result summary (any tool)', () => {
    renderTool(internalToolProps, 'compact');
    expect(screen.queryByRole('button', { name: /expand details/i })).not.toBeInTheDocument();
    expect(screen.queryByText('3 matches')).not.toBeInTheDocument();
  });

  it('compact treats external (MCP) tools the same — no expander', () => {
    // Detail level is a pure verbosity axis; it no longer special-cases tool origin.
    renderTool({ ...internalToolProps, toolName: 'web.echo' }, 'compact');
    expect(screen.queryByRole('button', { name: /expand details/i })).not.toBeInTheDocument();
  });

  it('standard shows the summary and a collapsed expander', () => {
    renderTool(internalToolProps, 'standard');
    expect(screen.getByText('3 matches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand details/i })).toBeInTheDocument();
    expect(screen.queryByText('Arguments:')).not.toBeInTheDocument();
  });

  it('developer auto-expands args/result and surfaces raw I/O metadata', () => {
    renderTool(internalToolProps, 'developer');
    // No click needed — developer opens the panes by default.
    expect(screen.getByText('Arguments:')).toBeInTheDocument();
    expect(screen.getByText('Result:')).toBeInTheDocument();
    // Raw I/O detail that standard hides.
    expect(screen.getByText('call-internal-1')).toBeInTheDocument();
  });

  it('standard does not leak the raw tool-call id', () => {
    renderTool(internalToolProps, 'standard');
    expect(screen.queryByText('call-internal-1')).not.toBeInTheDocument();
  });

  // BST-1681 phase 3: the three levels drive the STEP ROW, so pin what each
  // one puts in the row rather than only what it puts in the panes below.
  // Read the level as a RESULT-SUMMARY axis: compact hides result summaries,
  // not the `in <root>` chip, which is target disambiguation rather than a
  // summary and stays at every level by ruling.
  it('compact renders no result-summary chip (the root-name chip is target disambiguation and is not gated)', () => {
    // `policy.showResultSummary` is false, so `trailing` collapses to nothing
    // and the row is verb + target only. Fixture scope, stated so the zero
    // count is not read as a claim about every result: the sibling
    // "in <rootName>" chip is a `.bs-step-row-meta` the policy does not gate,
    // so a result carrying `rootName` still renders one chip at compact —
    // deliberately. This fixture carries none, which is why the count is 0.
    const { container } = renderTool(internalToolProps, 'compact');
    expect(screen.getByTestId('activity-step-row')).toBeInTheDocument();
    expect(container.querySelectorAll('.bs-step-row-meta')).toHaveLength(0);
  });

  it('standard renders the result summary as the row’s trailing meta chip', () => {
    const { container } = renderTool(internalToolProps, 'standard');
    const chips = [...container.querySelectorAll('.bs-step-row-meta')].map(
      (chip) => chip.textContent
    );
    expect(chips).toEqual(['3 matches']);
  });

  it('developer opens the row on mount: aria-expanded is true with no click', () => {
    // `policy.defaultExpanded` seeds `isCollapsed` false, and the ROW is the
    // expander (BST-1681), so the row itself must report the open body — not
    // just the panes being in the DOM.
    renderTool(internalToolProps, 'developer');
    const row = screen.getByTestId('activity-step-row');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    // BST-1682: the name leads with the visible content, so the affordance
    // is asserted as the trailing clause it now is.
    expect(row).toHaveAccessibleName(/, collapse details$/);
  });

  it('re-syncs an already-rendered card when the Detail level changes', () => {
    // Regression: collapse state was seeded once, so switching to Developer
    // never expanded cards that were already on screen.
    function Harness() {
      const { setDetailLevel } = useAssistantDetailLevel();
      const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
      return (
        <>
          <button onClick={() => setDetailLevel('developer')} type="button">
            go developer
          </button>
          <Comp {...internalToolProps} />
        </>
      );
    }

    window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, 'standard');
    render(
      <TooltipProvider>
        <AssistantDetailLevelProvider>
          <Harness />
        </AssistantDetailLevelProvider>
      </TooltipProvider>
    );

    // Standard: collapsed, no panes.
    expect(screen.queryByText('Arguments:')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'go developer' }));

    // Developer: the existing card auto-expands its panes.
    expect(screen.getByText('Arguments:')).toBeInTheDocument();
    expect(screen.getByText('Result:')).toBeInTheDocument();
  });
});
