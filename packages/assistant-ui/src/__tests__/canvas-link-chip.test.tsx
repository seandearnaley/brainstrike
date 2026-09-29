import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssistantLinkCapabilities } from '../assistant-link-capabilities';
import { AssistantLinkCapabilitiesProvider } from '../assistant-link-capabilities-provider';
import { ToolFallback } from '../tool-fallback';
import { type LooseProps, toolPartElement } from './tool-part-render';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

const CANVAS_ID = '019a0b3c-4d5e-7f60-8a1b-2c3d4e5f6071';

function renderCard(
  props: LooseProps<ComponentProps<typeof ToolFallback>>,
  capabilities: AssistantLinkCapabilities | null = {
    openLink: vi.fn().mockResolvedValue({ ok: true }),
  }
) {
  const element = toolPartElement(ToolFallback, {
    argsText: '{}',
    status: { type: 'complete' },
    toolName: 'brainstrike.manageCanvas',
    ...props,
  });
  return render(
    <TooltipProvider>
      {capabilities ? (
        <AssistantLinkCapabilitiesProvider capabilities={capabilities}>
          {element}
        </AssistantLinkCapabilitiesProvider>
      ) : (
        element
      )}
    </TooltipProvider>
  );
}

describe('canvas link chip on the manageCanvas card', () => {
  it('renders a canvas://<id> chip for a create result and opens it through the link seam', () => {
    const openLink = vi.fn().mockResolvedValue({ ok: true });
    renderCard({ result: { canvasId: CANVAS_ID, version: 1 } }, { openLink });

    const chip = screen.getByTestId('canvas-link-chip');
    expect(chip).toHaveTextContent(`canvas://${CANVAS_ID}`);
    expect(chip).toHaveTextContent('v1');
    expect(chip).toHaveAttribute('data-canvas-id', CANVAS_ID);

    fireEvent.click(chip);
    expect(openLink).toHaveBeenCalledWith(`canvas://${CANVAS_ID}`);
  });

  it('renders for update/rewrite results and for the Mastra-sanitized (hydrated) tool name', () => {
    renderCard({
      result: { canvasId: CANVAS_ID, version: 4 },
      toolName: 'brainstrike_manageCanvas',
    });
    expect(screen.getByTestId('canvas-link-chip')).toHaveTextContent('v4');
  });

  it.each([
    ['a list result', { canvases: [], truncated: false }],
    ['a refusal', { error: 'empty_document', hint: 'create when ready', ok: false }],
    ['a not_found failure', { error: 'not_found', ok: false }],
    ['an unlinkable id', { canvasId: 'a/b', version: 1 }],
  ])('renders no chip for %s', (_label, result) => {
    renderCard({ result });
    expect(screen.queryByTestId('canvas-link-chip')).not.toBeInTheDocument();
  });

  it('renders no chip for the same result shape under another tool', () => {
    // Mutation: dropping the tool-name gate in readCanvasMutationResult fails this row.
    renderCard({ result: { canvasId: CANVAS_ID, version: 1 }, toolName: 'searchDocs' });
    expect(screen.queryByTestId('canvas-link-chip')).not.toBeInTheDocument();
  });

  it('renders no chip while the call is still running', () => {
    renderCard({ result: undefined, status: { type: 'running' } });
    expect(screen.queryByTestId('canvas-link-chip')).not.toBeInTheDocument();
  });

  it('is visibly disabled when the host has not wired link capabilities', () => {
    renderCard({ result: { canvasId: CANVAS_ID, version: 1 } }, null);
    const chip = screen.getByTestId('canvas-link-chip');
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'Canvas links are not wired in this host');
  });
});
