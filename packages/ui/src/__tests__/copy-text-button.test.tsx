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

import { CopyTextButton } from '../copy-text-button';

describe('CopyTextButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  it('renders an icon-only button with the given aria-label', () => {
    render(<CopyTextButton ariaLabel="Copy note content" text="hello" />);
    const button = screen.getByRole('button', { name: 'Copy note content' });
    expect(button).toBeInTheDocument();
    expect(button).not.toHaveTextContent('Copy');
  });

  it('renders an optional visible label', () => {
    render(<CopyTextButton ariaLabel="Copy note content" label="Copy" text="hello" />);
    expect(screen.getByRole('button', { name: 'Copy note content' })).toHaveTextContent('Copy');
  });

  it('routes the copy through the shared clipboard service', async () => {
    render(<CopyTextButton ariaLabel="Copy note content" text="note body" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy note content' }));

    await waitFor(() => {
      expect(clipboardMocks.writeText).toHaveBeenCalledWith('note body');
    });
  });

  it('shows a transient copied state and swaps the label', async () => {
    render(<CopyTextButton ariaLabel="Copy note content" label="Copy" text="note body" />);
    const button = screen.getByRole('button', { name: 'Copy note content' });

    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveTextContent('Copied');
    });
  });

  it('ignores re-clicks while in the copied state', async () => {
    render(<CopyTextButton ariaLabel="Copy note content" label="Copy" text="note body" />);
    const button = screen.getByRole('button', { name: 'Copy note content' });

    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toHaveTextContent('Copied');
    });
    fireEvent.click(button);

    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1);
  });

  it('does not copy when the text is empty', () => {
    render(<CopyTextButton ariaLabel="Copy note content" text="" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy note content' }));

    expect(clipboardMocks.writeText).not.toHaveBeenCalled();
  });
});
