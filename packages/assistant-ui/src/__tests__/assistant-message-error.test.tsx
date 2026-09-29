import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessageError } from '../assistant-message-error';

// Mirrors the real primitives' contract: Root is an unconditional wrapper div
// (role="alert" live region), while Message renders ONLY when the message has
// an error (the real implementation returns null from useMessageError).
const { errorHolder } = vi.hoisted(() => ({
  errorHolder: { current: undefined as string | undefined },
}));

vi.mock('@assistant-ui/react', () => ({
  ErrorPrimitive: {
    Message: ({ ...props }: { className?: string }) =>
      errorHolder.current === undefined ? null : <span {...props}>{errorHolder.current}</span>,
    Root: ({ children, ...props }: { children?: React.ReactNode; className?: string }) => (
      <div role="alert" {...props}>
        {children}
      </div>
    ),
  },
}));

describe('AssistantMessageError', () => {
  beforeEach(() => {
    errorHolder.current = undefined;
  });

  it('renders no visible chrome when the message has no error', () => {
    const { container } = render(<AssistantMessageError />);

    // The bug: styling the always-rendered Root paints an empty red bar under
    // EVERY assistant message. All visible styling must live on the
    // error-conditional Message element.
    expect(container.querySelector('[class*="destructive"]')).toBeNull();
    expect(container.querySelector('[class*="border"]')).toBeNull();
  });

  it('renders the error text with destructive styling when the message failed', () => {
    errorHolder.current = 'Status 502: agent_stream_init_failed';

    const { container, getByText } = render(<AssistantMessageError />);

    expect(getByText('Status 502: agent_stream_init_failed')).toBeInTheDocument();
    expect(container.querySelector('[class*="destructive"]')).not.toBeNull();
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

    const { getByText } = render(<AssistantMessageError />);

    expect(getByText((text) => text.includes(recovery))).toBeInTheDocument();
  });
});
