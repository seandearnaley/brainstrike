import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import { ToolFallback } from '../tool-fallback';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

function renderTool(props: Record<string, unknown>) {
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(
    <TooltipProvider>
      <Comp {...props} />
    </TooltipProvider>
  );
}

describe('ToolFallback', () => {
  it('renders an internal tool with category attr and no redundant status badge', () => {
    renderTool({
      argsText: '{"q":"x"}',
      result: { ok: true },
      status: { type: 'complete' },
      toolName: 'brainstrike.queryEmbeddingSpace',
    });
    const card = screen.getByTestId('tool-fallback');
    expect(card.getAttribute('data-tool-category')).toBe('internal');
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('classifies a non-brainstrike tool as mcp and reveals args + result on expand', () => {
    renderTool({
      argsText: '{"q":"x"}',
      result: { answer: 42 },
      status: { type: 'complete' },
      toolName: 'searchDocs',
    });
    const card = screen.getByTestId('tool-fallback');
    expect(card.getAttribute('data-tool-category')).toBe('mcp');
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText(/Arguments/i)).toBeInTheDocument();
    expect(screen.getByText(/Result/i)).toBeInTheDocument();
  });
});
