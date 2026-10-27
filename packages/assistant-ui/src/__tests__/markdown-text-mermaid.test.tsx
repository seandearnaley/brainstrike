import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  ComposerPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMessageText } from '../assistant-message-text';

const DIAGRAM = 'Here is the flow:\n\n```mermaid\nflowchart LR\n  A[Draft] --> B[Published]\n```';
const OPEN_FENCE = `${DIAGRAM}\n\nAnd the queue:\n\n\`\`\`mermaid\nflowchart LR\n  C[Queued] -->`;
const CLOSED_FENCE = `${OPEN_FENCE} D[Sent]\n\`\`\``;

/** Streams a reply whose second mermaid fence arrives in two pieces, each released by the test. */
function createStreamingDiagramAdapter(): {
  readonly adapter: ChatModelAdapter;
  readonly closeFence: () => void;
  readonly finish: () => void;
} {
  let releaseCloseFence: (() => void) | undefined;
  let releaseFinish: (() => void) | undefined;
  const fenceClosed = new Promise<void>((resolve) => {
    releaseCloseFence = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });

  const adapter: ChatModelAdapter = {
    async *run() {
      yield { content: [{ text: OPEN_FENCE, type: 'text' as const }] };
      await fenceClosed;
      yield { content: [{ text: CLOSED_FENCE, type: 'text' as const }] };
      await finished;
    },
  };

  return {
    adapter,
    closeFence: () => releaseCloseFence?.(),
    finish: () => releaseFinish?.(),
  };
}

function Harness({
  adapter,
  initialMessages,
}: {
  readonly adapter: ChatModelAdapter;
  readonly initialMessages?: readonly ThreadMessageLike[];
}): ReactElement {
  const runtime = useLocalRuntime(adapter, initialMessages ? { initialMessages } : {});

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages
            components={{
              AssistantMessage: () => (
                <MessagePrimitive.Parts components={{ Text: AssistantMessageText }} />
              ),
              UserMessage: () => null,
            }}
          />
          <ComposerPrimitive.Root>
            <ComposerPrimitive.Input aria-label="Message input" />
            <ComposerPrimitive.Send aria-label="Send" />
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

async function drawnDiagram(): Promise<HTMLElement> {
  await waitFor(
    () => {
      expect(screen.getByTestId('mermaid-diagram').querySelector('svg')).not.toBeNull();
    },
    { timeout: 10_000 }
  );
  return screen.getByTestId('mermaid-diagram');
}

describe('mermaid fences in assistant replies', () => {
  it('draw as a diagram in a finished reply', async () => {
    const idle: ChatModelAdapter = {
      run: vi.fn().mockResolvedValue({ content: [], status: { reason: 'stop', type: 'complete' } }),
    };
    const { container } = render(
      <Harness
        adapter={idle}
        initialMessages={[
          {
            content: [{ text: DIAGRAM, type: 'text' }],
            role: 'assistant',
            status: { reason: 'stop', type: 'complete' },
          },
        ]}
      />
    );

    const diagram = await drawnDiagram();
    expect(diagram).toHaveTextContent('Published');
    expect(container.querySelector('.aui-md pre')).toBeNull();
  }, 15_000);

  it('show a fence as code while it streams, and draw it once it closes', async () => {
    const user = userEvent.setup();
    const stream = createStreamingDiagramAdapter();
    const { container } = render(<Harness adapter={stream.adapter} />);

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Draw the flow.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // The finished diagram draws mid-reply; the half-written one stays its
    // source, never a parse error.
    expect(await drawnDiagram()).toHaveTextContent('Published');
    expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(1);
    expect(container.querySelector('.aui-md pre')?.textContent).toContain('C[Queued] -->');

    stream.closeFence();
    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-diagram')[1]?.querySelector('svg')).toBeTruthy();
    });
    expect(screen.getAllByTestId('mermaid-diagram')[1]).toHaveTextContent('Sent');
    expect(container.querySelector('.aui-md pre')).toBeNull();
    stream.finish();
  }, 30_000);
});
