import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import type { AssistantDetailLevel } from '../assistant-detail-level';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
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
  type: 'tool-call' as const,
  toolCallId: 'call-internal-1',
  toolName: 'brainstrike.grepSearch',
  args: { query: 'foo' },
  argsText: '{"query":"foo"}',
  status: { type: 'complete' as const },
  result: { matches: [{ a: 1 }, { a: 2 }, { a: 3 }] },
  addResult: () => {},
  resume: () => {},
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
    expect(screen.queryByRole('button', { name: 'Expand details' })).not.toBeInTheDocument();
    expect(screen.queryByText('3 matches')).not.toBeInTheDocument();
  });

  it('compact treats external (MCP) tools the same — no expander', () => {
    // Detail level is a pure verbosity axis; it no longer special-cases tool origin.
    renderTool({ ...internalToolProps, toolName: 'web.echo' }, 'compact');
    expect(screen.queryByRole('button', { name: 'Expand details' })).not.toBeInTheDocument();
  });

  it('standard shows the summary and a collapsed expander', () => {
    renderTool(internalToolProps, 'standard');
    expect(screen.getByText('3 matches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand details' })).toBeInTheDocument();
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
});
