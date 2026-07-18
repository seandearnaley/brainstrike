import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({
    writeText: clipboardMocks.writeText,
  }),
}));

// Same module the chat pipeline mocks (markdown-text.test.tsx) — the header
// MUST import ../assistant-ui-panel/tooltip-icon-button for that seam to hold.
vi.mock('../../assistant-ui-panel/tooltip-icon-button', () => ({
  TooltipIconButton: ({
    children,
    onClick,
    tooltip,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    tooltip?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} title={tooltip} type="button" {...props}>
      {children}
    </button>
  ),
}));

import { CodeBlockHeader } from '../code-block-header';

describe('CodeBlockHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    // The chat markdown library labels unlabeled fences "unknown" — never
    // surface that string to users.
    ['unknown', 'unknown'],
  ])('falls back to "code" when the language is %s', (_name, language) => {
    render(<CodeBlockHeader code="const x = 1;" language={language} />);
    expect(screen.getByText('code')).toBeInTheDocument();
  });

  it('shows the fence language when present', () => {
    render(<CodeBlockHeader code="const x = 1;" language="typescript" />);
    expect(screen.getByText('typescript')).toBeInTheDocument();
  });

  it('copies the code through the shared clipboard service with a transient tooltip swap', async () => {
    render(<CodeBlockHeader code="const answer = 42;" language="typescript" />);
    const copyButton = screen.getByRole('button', { name: 'Copy code to clipboard' });
    expect(copyButton).toHaveAttribute('title', 'Copy code');

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copied!');
    });
    fireEvent.click(copyButton);

    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1);
    expect(clipboardMocks.writeText).toHaveBeenCalledWith('const answer = 42;');
  });

  it('visibly surfaces a failed copy: tooltip flips to "Copy failed" with a destructive tint', async () => {
    clipboardMocks.writeText.mockResolvedValue({ error: 'bridge rejected', ok: false });

    const { container } = render(<CodeBlockHeader code="const x = 1;" language="typescript" />);
    const copyButton = screen.getByRole('button', { name: 'Copy code to clipboard' });

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copy failed');
    });
    expect(container.querySelector('.text-destructive')).not.toBeNull();
    // Screen-reader announcement, not just a hover-only tooltip.
    const liveRegion = container.querySelector('[role="status"][aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toHaveTextContent('Copy failed');
  });

  it('allows an immediate retry after a failed copy', async () => {
    clipboardMocks.writeText.mockResolvedValueOnce({ error: 'bridge rejected', ok: false });

    render(<CodeBlockHeader code="const x = 1;" language="typescript" />);
    const copyButton = screen.getByRole('button', { name: 'Copy code to clipboard' });

    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copy failed');
    });

    clipboardMocks.writeText.mockResolvedValue({ ok: true });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copied!');
    });
    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(2);
  });

  it('does not copy when the code is empty', () => {
    render(<CodeBlockHeader code="" language="typescript" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code to clipboard' }));

    expect(clipboardMocks.writeText).not.toHaveBeenCalled();
  });
});
