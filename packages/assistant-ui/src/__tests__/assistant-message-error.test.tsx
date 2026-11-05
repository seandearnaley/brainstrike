import { act } from '@brainstrike/test-utils/react-act';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode, Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessageError } from '../assistant-message-error';

// Mirrors the real primitives' contract: Root is an unconditional wrapper div
// (role="alert" live region), Message renders the message's error text, and
// the block reads the message status and the thread's reload capability.
const { errorHolder, reloadHolder, reloadMock, clipboardMocks } = vi.hoisted(() => ({
  clipboardMocks: { writeText: vi.fn() },
  errorHolder: { current: undefined as string | undefined },
  reloadHolder: { current: true },
  reloadMock: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({ writeText: clipboardMocks.writeText }),
}));

vi.mock('@assistant-ui/react', () => ({
  ActionBarPrimitive: {
    // asChild: the child button IS the reload control.
    Reload: ({ children }: { asChild?: boolean; children: ReactNode }) => (
      <span onClickCapture={reloadMock}>{children}</span>
    ),
  },
  ErrorPrimitive: {
    Message: ({ ref, ...props }: { className?: string; ref?: Ref<HTMLSpanElement> }) =>
      errorHolder.current === undefined ? null : (
        <span ref={ref} {...props}>
          {errorHolder.current}
        </span>
      ),
    Root: ({ children, ...props }: { children?: ReactNode; className?: string }) => (
      <div role="alert" {...props}>
        {children}
      </div>
    ),
  },
  useAuiState: <T,>(
    selector: (state: {
      message: { status?: { error?: string; reason: string; type: string } };
      thread: { capabilities: { reload: boolean } };
    }) => T
  ): T =>
    selector({
      message: {
        status:
          errorHolder.current === undefined
            ? { reason: 'stop', type: 'complete' }
            : { error: errorHolder.current, reason: 'error', type: 'incomplete' },
      },
      thread: { capabilities: { reload: reloadHolder.current } },
    }),
}));

describe('AssistantMessageError', () => {
  beforeEach(() => {
    errorHolder.current = undefined;
    reloadHolder.current = true;
    reloadMock.mockReset();
    clipboardMocks.writeText.mockReset();
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  it('renders no visible chrome when the message has no error', () => {
    const { container } = render(<AssistantMessageError />);

    // The bug: styling the always-rendered Root paints an empty red bar under
    // EVERY assistant message. All visible styling must live inside the
    // error-conditional block.
    expect(container.querySelector('[class*="destructive"]')).toBeNull();
    expect(container.querySelector('[class*="border"]')).toBeNull();
    expect(screen.queryByText('Response failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('titles the failure and shows the raw error text', () => {
    errorHolder.current = 'Status 502: agent_stream_init_failed';

    const { container } = render(<AssistantMessageError />);

    expect(screen.getByText('Response failed')).toBeInTheDocument();
    expect(screen.getByText('Status 502: agent_stream_init_failed')).toBeInTheDocument();
    expect(container.querySelector('[class*="destructive"]')).not.toBeNull();
  });

  it('offers Retry inside the block where the runtime can reload', () => {
    errorHolder.current = 'Status 502: agent_stream_init_failed';

    render(<AssistantMessageError />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('offers no Retry where the runtime cannot reload', () => {
    errorHolder.current = 'Status 502: agent_stream_init_failed';
    reloadHolder.current = false;

    render(<AssistantMessageError />);

    expect(screen.getByText('Response failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('copies the raw error text', async () => {
    errorHolder.current = 'Status 429: rate_limited';

    render(<AssistantMessageError />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy error message' }));
    });

    expect(clipboardMocks.writeText).toHaveBeenCalledWith('Status 429: rate_limited');
  });

  it('renders the pre-upgrade recovery action on the failed approval message', () => {
    const recovery =
      'This approval predates the background ledger upgrade and cannot resume safely. Stop or cancel the pending work, then start a new request.';
    errorHolder.current = `Status 409: ${JSON.stringify({
      code: 'background-generation-unmapped',
      error: 'decision_refused',
      message: recovery,
      stage: 'stream_construction',
    })}`;

    render(<AssistantMessageError />);

    expect(screen.getByText((text) => text.includes(recovery))).toBeInTheDocument();
  });
});
