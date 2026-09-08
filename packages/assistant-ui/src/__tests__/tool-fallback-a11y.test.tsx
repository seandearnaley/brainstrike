import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { beforeAll, describe, expect, test } from 'vitest';
import { ToolFallback } from '../tool-fallback';

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
    // BST-1681: the row IS the toggle, so its `title` is the raw tool id
    // (hover inspection); the expand/collapse wording lives in the
    // accessible name asserted above.
    expect(button).toHaveAttribute('title', 'test-tool');

    await user.click(button);

    const expandedButton = screen.getByRole('button', { name: /Collapse details/i });
    expect(expandedButton).toHaveAttribute('aria-expanded', 'true');
    expect(expandedButton).toHaveAttribute('title', 'test-tool');
  });

  test('aria-controls points to a real DOM element when expanded', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<ToolFallback {...mockBaseProps} result="test-result" />);

    const button = screen.getByRole('button', { name: /Expand details/i });
    // BST-1681: the row keeps a STABLE `aria-controls` across the toggle (the
    // disclosure pattern — the pane it names is mounted only while expanded,
    // which `aria-expanded="false"` already announces). What must never drift
    // is the id it points at once the pane exists; whether that id resolves to
    // nothing WHILE collapsed is an implementation detail of the pattern, not
    // a contract, so it is deliberately not pinned here.
    const controlsId = button.getAttribute('aria-controls');
    if (controlsId === null || controlsId.length === 0) {
      throw new Error('the row must name the pane it toggles');
    }
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);

    const expandedButton = screen.getByRole('button', { name: /Collapse details/i });
    expect(expandedButton).toHaveAttribute('aria-controls', controlsId);
    expect(expandedButton).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector(`#${CSS.escape(controlsId)}`)).toBeInTheDocument();

    await user.click(expandedButton);
    const collapsedButton = screen.getByRole('button', { name: /Expand details/i });
    expect(collapsedButton).toHaveAttribute('aria-controls', controlsId);
    expect(collapsedButton).toHaveAttribute('aria-expanded', 'false');
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
    const [first, second] = buttons;
    expect(first?.getAttribute('aria-controls')).toBeTruthy();
    expect(first?.getAttribute('aria-controls')).not.toBe(second?.getAttribute('aria-controls'));
    expect(container.querySelector('[id^="radix-"]')).not.toBeInTheDocument();
  });
});
