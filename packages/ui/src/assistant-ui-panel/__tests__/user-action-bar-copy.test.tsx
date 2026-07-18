/**
 * The user-message copy control MUST route through the shared clipboard
 * service (useCopyToClipboard / @brainstrike/context-actions), like every
 * other copy affordance this PR standardizes -- NOT
 * ActionBarPrimitive.Copy's built-in navigator.clipboard.writeText, which
 * swallows write rejections and would silently do nothing on a broken
 * Electron bridge (review finding, no-silent-fallbacks rule).
 */

import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({
    writeText: clipboardMocks.writeText,
  }),
}));

// Same seam CodeBlockHeader's tests use: swap in a plain button so the
// tooltip text is queryable via the `title` attribute instead of a
// hover-triggered Radix portal.
vi.mock('../tooltip-icon-button', () => ({
  TooltipIconButton: ({
    children,
    onClick,
    tooltip,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    tooltip?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} title={tooltip} type="button" {...props}>
      {children}
    </button>
  ),
}));

import { UserActionBar } from '../assistant-ui-panel';

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

function Harness({ text }: { text: string }) {
  const initialMessages: readonly ThreadMessageLike[] = [
    { content: [{ text, type: 'text' }], role: 'user' },
  ];
  const runtime = useLocalRuntime(chatModel, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: () => null,
          UserMessage: UserActionBar,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

describe('UserActionBar copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  it('copies the user message text through the shared clipboard service', async () => {
    render(<Harness text="Hello world" />);
    // useLocalRuntime hydrates initialMessages asynchronously.
    const copyButton = await screen.findByRole('button', { name: 'Copy message' });
    expect(copyButton).toHaveAttribute('title', 'Copy');

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copied!');
    });
    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1);
    expect(clipboardMocks.writeText).toHaveBeenCalledWith('Hello world');
  });

  it('visibly surfaces a failed copy ({ok: false}): destructive tint + announced "Copy failed"', async () => {
    clipboardMocks.writeText.mockResolvedValue({ error: 'bridge rejected', ok: false });

    const { container } = render(<Harness text="Hello world" />);
    const copyButton = await screen.findByRole('button', { name: 'Copy message' });

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copy failed');
    });
    expect(clipboardMocks.writeText).toHaveBeenCalledWith('Hello world');
    expect(container.querySelector('.text-destructive')).not.toBeNull();

    const liveRegion = container.querySelector('[role="status"][aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toHaveTextContent('Copy failed');
  });

  it('allows an immediate retry after a failed copy', async () => {
    clipboardMocks.writeText.mockResolvedValueOnce({ error: 'bridge rejected', ok: false });

    render(<Harness text="Hello world" />);
    const copyButton = await screen.findByRole('button', { name: 'Copy message' });

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
});
