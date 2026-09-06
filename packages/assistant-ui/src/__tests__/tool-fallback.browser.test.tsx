import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { ToolFallback } from '../tool-fallback';

const baseProps = {
  addResult: () => {},
  args: { text: 'hello' },
  argsText: '{"text":"hello"}',
  respondToApproval: () => Promise.resolve(),
  resume: () => {},
  status: { type: 'complete' as const },
  toolCallId: 'browser-tool-call',
  toolName: 'browser.echo',
  type: 'tool-call' as const,
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
