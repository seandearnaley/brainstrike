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

  it('renders a persisted guarded result as failed when the tool part isError flag is set', () => {
    renderTool({
      argsText: '{"path":"package.json"}',
      isError: true,
      result: {
        error: {
          code: 'tool_failed',
          message: 'The tool did not complete successfully. Try another approach.',
        },
        ok: false,
      },
      status: { type: 'complete' },
      toolName: 'brainstrike.readWorkspaceFile',
    });

    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(
      screen.getByText('The tool did not complete successfully. Try another approach.')
    ).toBeInTheDocument();
  });

  it('does not classify a successful payload with nested error metadata as failed', () => {
    renderTool({
      argsText: '{}',
      result: { error: { message: 'advisory only' }, ok: true },
      status: { type: 'complete' },
      toolName: 'lookupStatus',
    });

    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).toBeNull();
    expect(screen.queryByText('advisory only')).toBeNull();
  });

  it('does not serialize the result while the details pane is collapsed', () => {
    // Tool results are budgeted at ~3k tokens (~12 KB serialized); every card
    // in the streaming turn re-renders per chunk, so an eager JSON.stringify
    // of a collapsed card's result is pure per-chunk waste. Serialization must
    // only happen once the details pane is actually open.
    let deepReads = 0;
    const result = {
      ok: true,
      get payloadBlob() {
        deepReads += 1;
        return 'x'.repeat(64);
      },
    };
    renderTool({
      argsText: '{"q":"x"}',
      result,
      status: { type: 'complete' },
      toolName: 'searchDocs',
    });

    expect(deepReads).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText(/Result/i)).toBeInTheDocument();
    expect(deepReads).toBeGreaterThan(0);
  });
});
