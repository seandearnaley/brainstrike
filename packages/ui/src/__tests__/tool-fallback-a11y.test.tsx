import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, describe } from 'vitest';
import { ToolFallback } from '../assistant-ui-panel/tool-fallback';

// intentionally minimal mock — see BST-469
const mockBaseProps = {
  toolName: 'test-tool',
  argsText: '{"foo": "bar"}',
  status: { type: 'complete' as const },
  part: {} as Record<string, unknown>,
  addResult: () => {},
};

describe('ToolFallback Accessibility', () => {
  test('expand/collapse button has correct aria-expanded state', async () => {
    const user = userEvent.setup();
    render(
      <ToolFallback
        toolName="test-tool"
        argsText='{"foo": "bar"}'
        status={{ type: 'success' }}
      />
    );

    const button = screen.getByRole('button', { name: /Collapse details/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('title', 'Collapse details');

    await user.click(button);

    const expandedButton = screen.getByRole('button', { name: /Expand details/i });
    expect(expandedButton).toHaveAttribute('aria-expanded', 'false');
    expect(expandedButton).toHaveAttribute('title', 'Expand details');
  });

  test('aria-controls points to a real DOM element when expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolFallback {...mockBaseProps} result="test-result" />
    );

    const button = screen.getByRole('button', { name: /Collapse details/i });
    const controlsId = button.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    const controlledElement = container.querySelector(`#${CSS.escape(controlsId as string)}`);
    expect(controlledElement).toBeInTheDocument();

    // After collapsing, aria-controls should be removed since the target is unmounted
    await user.click(button);
    const collapsedButton = screen.getByRole('button', { name: /Expand details/i });
    expect(collapsedButton).not.toHaveAttribute('aria-controls');
    expect(container.querySelector(`#${CSS.escape(controlsId as string)}`)).not.toBeInTheDocument();
  });

  test('multiple instances have unique aria-controls IDs', () => {
    const { container } = render(
      <>
        <ToolFallback {...mockBaseProps} result="result-a" toolCallId="call-a" toolName="tool-a" />
        <ToolFallback {...mockBaseProps} result="result-b" toolCallId="call-b" toolName="tool-b" />
      </>
    );

    const buttons = screen.getAllByRole('button', { name: /Collapse details/i });
    expect(buttons).toHaveLength(2);

    const id1 = buttons[0]?.getAttribute('aria-controls');
    const id2 = buttons[1]?.getAttribute('aria-controls');
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);

    // Both IDs should resolve to real DOM elements
    expect(container.querySelector(`#${CSS.escape(id1 as string)}`)).toBeInTheDocument();
    expect(container.querySelector(`#${CSS.escape(id2 as string)}`)).toBeInTheDocument();
  });
});
