import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { ToolFallback } from '../assistant-ui-panel/tool-fallback';
import { TooltipProvider } from '../tooltip';

const baseProps = {
  type: 'tool-call' as const,
  toolCallId: 'browser-tool-call',
  toolName: 'browser.echo',
  args: { text: 'hello' },
  argsText: '{"text":"hello"}',
  status: { type: 'complete' as const },
  addResult: () => {},
  resume: () => {},
};

describe('ToolFallback browser behavior', () => {
  test('keeps tool details collapsed until the user expands them', async () => {
    const user = userEvent.setup();

    // ToolFallback's status tooltip needs the app-level TooltipProvider
    // (mounted once in app-shell's app-layout in the real app).
    render(
      <TooltipProvider>
        <ToolFallback {...baseProps} result={{ echoed: 'hello' }} />
      </TooltipProvider>
    );

    expect(screen.queryByText('Arguments:')).not.toBeInTheDocument();
    expect(screen.queryByText('Result:')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand details' }));

    expect(screen.getByText('Arguments:')).toBeVisible();
    expect(screen.getByText('Result:')).toBeVisible();
    expect(screen.getByText(/echoed/)).toBeVisible();
  });
});
