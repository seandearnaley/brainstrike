import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { beforeAll, describe, expect, test } from 'vitest';
import { ToolFallback } from '../assistant-ui-panel/tool-fallback';
import { TooltipProvider } from '../tooltip';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

// intentionally minimal mock — see BST-469
const mockBaseProps = {
  addResult: () => {},
  args: { foo: 'bar' },
  argsText: '{"foo": "bar"}',
  resume: () => {},
  status: { type: 'complete' },
  toolCallId: 'test-call-id',
  toolName: 'test-tool',
  type: 'tool-call',
} as unknown as ComponentProps<typeof ToolFallback>;

function wrap(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('ToolFallback Accessibility', () => {
  test('expand/collapse button has correct aria-expanded state', async () => {
    const user = userEvent.setup();
    wrap(<ToolFallback {...mockBaseProps} />);

    const button = screen.getByRole('button', { name: /Expand details/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('title', 'Expand details');

    await user.click(button);

    const expandedButton = screen.getByRole('button', { name: /Collapse details/i });
    expect(expandedButton).toHaveAttribute('aria-expanded', 'true');
    expect(expandedButton).toHaveAttribute('title', 'Collapse details');
  });

  test('aria-controls points to a real DOM element when expanded', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<ToolFallback {...mockBaseProps} result="test-result" />);

    const button = screen.getByRole('button', { name: /Expand details/i });
    expect(button).not.toHaveAttribute('aria-controls');

    await user.click(button);

    const expandedButton = screen.getByRole('button', { name: /Collapse details/i });
    const controlsId = expandedButton.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    const controlledElement = container.querySelector(`#${CSS.escape(controlsId as string)}`);
    expect(controlledElement).toBeInTheDocument();

    await user.click(expandedButton);
    const collapsedButton = screen.getByRole('button', { name: /Expand details/i });
    expect(collapsedButton).not.toHaveAttribute('aria-controls');
    expect(container.querySelector(`#${CSS.escape(controlsId as string)}`)).not.toBeInTheDocument();
  });

  test('multiple instances have unique aria-controls IDs', () => {
    const { container } = wrap(
      <>
        <ToolFallback {...mockBaseProps} result="result-a" toolCallId="call-a" toolName="tool-a" />
        <ToolFallback {...mockBaseProps} result="result-b" toolCallId="call-b" toolName="tool-b" />
      </>
    );

    const buttons = screen.getAllByRole('button', { name: /Expand details/i });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).not.toHaveAttribute('aria-controls');
    expect(buttons[1]).not.toHaveAttribute('aria-controls');
    expect(container.querySelector('[id^="radix-"]')).not.toBeInTheDocument();
  });
});
