import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { CHAIN_OF_THOUGHT_TOOL_COMPONENTS } from '../todo-progress';
import { ToolResultRendererProvider } from '../tool-result-renderer-context';
import type { ToolResultRenderer, ToolResultRendererProps } from '../use-tool-result-renderers';

const TOOL_CALL = {
  args: {},
  argsText: '{}',
  status: { type: 'complete' as const },
  toolCallId: 'call-1',
  toolName: 'render_widget',
} as unknown as ToolResultRendererProps;

const widgetRenderer: ToolResultRenderer = {
  Component: ({ toolName }) => <p data-testid="widget">widget for {toolName}</p>,
  kind: 'widget',
  matches: (result: unknown) => typeof result === 'object' && result !== null && 'widget' in result,
};

function renderFallback(
  renderers: readonly ToolResultRenderer[],
  result: unknown
): ReactElement | null {
  const Fallback = CHAIN_OF_THOUGHT_TOOL_COMPONENTS.Fallback;
  render(
    <TooltipProvider>
      <ToolResultRendererProvider renderers={renderers}>
        <Fallback {...TOOL_CALL} result={result} />
      </ToolResultRendererProvider>
    </TooltipProvider>
  );
  return null;
}

describe('tool result renderer seam', () => {
  it('routes a matching raw result to the registered renderer', () => {
    renderFallback([widgetRenderer], { widget: true });
    expect(screen.getByTestId('widget')).toHaveTextContent('widget for render_widget');
  });

  it('keeps a non-matching result on the shared tool fallback', () => {
    renderFallback([widgetRenderer], { ok: true });
    expect(screen.queryByTestId('widget')).not.toBeInTheDocument();
  });

  it('renders the ordinary fallback when no renderer is registered', () => {
    renderFallback([], { widget: true });
    expect(screen.queryByTestId('widget')).not.toBeInTheDocument();
  });
});
