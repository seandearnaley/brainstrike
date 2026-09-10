/**
 * The assistant-message copy control must (a) hand over the SAME text the user
 * sees — provider citation markers stripped, like the render seam — and (b)
 * route through the shared clipboard service rather than
 * ActionBarPrimitive.Copy's built-in navigator.clipboard.writeText, which
 * swallows write rejections (no-silent-fallbacks, same reasoning as
 * user-action-bar-copy.test.tsx).
 *
 * Copying a live message reads the in-memory parts straight off the stream, so
 * it is not covered by the write-time strip in the memory store.
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

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
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

import { AssistantActionBar } from '../assistant-action-bar';

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

function Harness({ text, recovery = false }: { text: string; recovery?: boolean }) {
  const initialMessages: readonly ThreadMessageLike[] = [
    {
      content: recovery
        ? [
            {
              data: { reason: 'request-failed' },
              name: 'suspended-run-discovery-error',
              type: 'data',
            },
          ]
        : [{ text, type: 'text' }],
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    },
  ];
  const runtime = useLocalRuntime(chatModel, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: AssistantActionBar,
          UserMessage: () => null,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

describe('AssistantActionBar copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  it('does not offer model regeneration for a decision discovery failure', () => {
    render(<Harness recovery text="" />);
    expect(screen.queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument();
    expect(chatModel.run).not.toHaveBeenCalled();
  });

  it('copies the answer without the provider citation markers', async () => {
    render(<Harness text={'Electron v43.2.0.\u{E200}cite\u{E202}turn0search0\u{E201}'} />);
    const copyButton = await screen.findByRole('button', { name: 'Copy message' });

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(clipboardMocks.writeText).toHaveBeenCalledWith('Electron v43.2.0.');
    });
  });

  it('ignores a second click while still showing "Copied!"', async () => {
    render(<Harness text="Plain answer" />);
    const copyButton = await screen.findByRole('button', { name: 'Copy message' });

    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copied!');
    });
    fireEvent.click(copyButton);

    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed copy instead of silently doing nothing', async () => {
    clipboardMocks.writeText.mockResolvedValue({ error: 'bridge rejected', ok: false });

    const { container } = render(<Harness text="Plain answer" />);
    const copyButton = await screen.findByRole('button', { name: 'Copy message' });

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copy failed');
    });
    const liveRegion = container.querySelector('[role="status"][aria-live="polite"]');
    expect(liveRegion).toHaveTextContent('Copy failed');
  });
});
