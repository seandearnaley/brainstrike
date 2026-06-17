import { render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import { ToolDurationProvider } from '../tool-duration-context';
import { ToolFallback } from '../tool-fallback';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

const baseProps = {
  type: 'tool-call' as const,
  toolCallId: 'call-x',
  toolName: 'brainstrike.grepSearch',
  args: { query: 'foo' },
  argsText: '{"query":"foo"}',
  status: { type: 'complete' as const },
  result: { matches: [] },
  addResult: () => {},
  resume: () => {},
};

function renderTool(durations: Record<string, number> | null) {
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
  const tool = <Comp {...baseProps} />;
  const tree: ReactNode = durations ? (
    <ToolDurationProvider durations={durations}>{tool}</ToolDurationProvider>
  ) : (
    tool
  );
  return render(<TooltipProvider>{tree}</TooltipProvider>);
}

describe('ToolFallback duration', () => {
  it('shows the execution time when a duration is provided for its tool call', () => {
    renderTool({ 'call-x': 1200 });
    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('shows nothing when no duration is available for the tool call', () => {
    renderTool({ 'other-call': 999 });
    expect(screen.queryByText(/\ds/)).not.toBeInTheDocument();
  });

  it('does not break without a duration provider', () => {
    renderTool(null);
    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
  });
});
