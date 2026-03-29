import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, describe } from 'vitest';
import { ToolFallback } from '../assistant-ui-panel/tool-fallback';

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
});
