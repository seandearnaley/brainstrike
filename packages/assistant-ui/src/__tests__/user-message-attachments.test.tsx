/**
 * BST-1575: image attachments on a sent user message render ABOVE the text
 * bubble, outside ExpandableMessageContent — the "Show more" text-truncation
 * affordance (collapsedHeight 176px) must never collapse an image (max-h-64 =
 * 256px trips it on every attached image). An attachment-only message renders
 * no empty bubble.
 */

import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same seam the user-action-bar copy test uses: swap the Radix tooltip button
// for a plain button so UserMessage mounts without a TooltipProvider portal.
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

import { UserMessage } from '../user-message';

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

const imageAttachment = {
  content: [{ image: PNG_DATA_URL, type: 'image' as const }],
  contentType: 'image/png',
  id: 'att-1',
  name: 'icon.png',
  status: { type: 'complete' as const },
  type: 'image' as const,
};

function Harness({ messages }: { messages: readonly ThreadMessageLike[] }) {
  const runtime = useLocalRuntime(chatModel, { initialMessages: messages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages
        components={{
          AssistantMessage: () => null,
          UserMessage,
        }}
      />
    </AssistantRuntimeProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('UserMessage attachments layout', () => {
  it('renders the image outside the expandable (Show more) region', async () => {
    render(
      <Harness
        messages={[
          {
            attachments: [imageAttachment],
            content: [{ text: 'look at this', type: 'text' }],
            role: 'user',
          },
        ]}
      />
    );

    const img = await screen.findByTestId('assistant-user-message-attachment');
    expect(img.closest('.bs-expandable-message')).toBeNull();
  });

  it('keeps the text bubble for the text parts only — no attachment inside it', async () => {
    render(
      <Harness
        messages={[
          {
            attachments: [imageAttachment],
            content: [{ text: 'look at this', type: 'text' }],
            role: 'user',
          },
        ]}
      />
    );

    const bubble = await screen.findByTestId('assistant-user-message-content');
    // The markdown renderer behind UserMessageText is lazy-loaded; on a loaded
    // runner the dynamic import can exceed waitFor's default 1s deadline while
    // the Suspense "Loading message…" placeholder is shown (same budget as
    // markdown-text-runtime.test.tsx).
    await waitFor(
      () => {
        expect(bubble).toHaveTextContent('look at this');
      },
      { timeout: 10_000 }
    );
    expect(within(bubble).queryByTestId('assistant-user-message-attachment')).toBeNull();
  }, 15_000);

  it('renders no empty text bubble for an attachment-only message', async () => {
    render(
      <Harness
        messages={[
          {
            attachments: [imageAttachment],
            content: [],
            role: 'user',
          },
        ]}
      />
    );

    await screen.findByTestId('assistant-user-message-attachment');
    expect(screen.queryByTestId('assistant-user-message-content')).toBeNull();
  });

  it('keeps the bubble for a message whose content holds only non-text parts', async () => {
    // The bubble gate must not silently drop non-text CONTENT parts (image /
    // file parts hydrated from persistence render via MessagePrimitive.Parts,
    // not via message.attachments) — BST-1575 review finding.
    render(
      <Harness
        messages={[
          {
            content: [{ image: PNG_DATA_URL, type: 'image' }],
            role: 'user',
          },
        ]}
      />
    );

    expect(await screen.findByTestId('assistant-user-message-content')).toBeInTheDocument();
  });

  it('promotes an in-thread image load failure to an explicit named placeholder', async () => {
    render(
      <Harness
        messages={[
          {
            attachments: [imageAttachment],
            content: [{ text: 'look at this', type: 'text' }],
            role: 'user',
          },
        ]}
      />
    );

    const img = await screen.findByTestId('assistant-user-message-attachment');
    fireEvent.error(img);

    expect(await screen.findByTestId('assistant-user-message-attachment-error')).toHaveTextContent(
      'Image unavailable: icon.png'
    );
    expect(screen.queryByTestId('assistant-user-message-attachment')).toBeNull();
  });
});
