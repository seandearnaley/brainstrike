// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AssistantActivityParts } from '../assistant-activity-parts';

function createStreamingReasoningAdapter(): {
  readonly adapter: ChatModelAdapter;
  readonly finish: () => void;
  readonly nextChunk: () => void;
} {
  let releaseNextChunk: (() => void) | undefined;
  let releaseFinish: (() => void) | undefined;
  const nextChunk = new Promise<void>((resolve) => {
    releaseNextChunk = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });

  const adapter: ChatModelAdapter = {
    async *run() {
      yield {
        content: [{ text: 'Inspect the workspace root.', type: 'reasoning' as const }],
      };
      await nextChunk;
      yield {
        content: [
          {
            text: 'Inspect the workspace root. Then enumerate the files.',
            type: 'reasoning' as const,
          },
          {
            args: { path: '.' },
            argsText: '{"path":"."}',
            toolCallId: 'call-list-files',
            toolName: 'list_files',
            type: 'tool-call' as const,
          },
        ],
      };
      await finish;
      yield {
        content: [
          {
            text: 'Inspect the workspace root. Then enumerate the files.',
            type: 'reasoning' as const,
          },
          {
            args: { path: '.' },
            argsText: '{"path":"."}',
            result: { files: ['index.html'] },
            toolCallId: 'call-list-files',
            toolName: 'list_files',
            type: 'tool-call' as const,
          },
          { text: 'Done.', type: 'text' as const },
        ],
      };
    },
  };

  return {
    adapter,
    finish: () => releaseFinish?.(),
    nextChunk: () => releaseNextChunk?.(),
  };
}

function StreamingReasoningHarness({
  adapter,
}: {
  readonly adapter: ChatModelAdapter;
}): ReactElement {
  const runtime = useLocalRuntime(adapter);

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages
            components={{
              AssistantMessage: () => (
                <MessagePrimitive.Root>
                  <AssistantActivityParts />
                </MessagePrimitive.Root>
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

describe('assistant reasoning disclosure (real streaming runtime)', () => {
  it('expands during live reasoning and stays interactive through a tool call', async () => {
    const user = userEvent.setup();
    const stream = createStreamingReasoningAdapter();

    render(<StreamingReasoningHarness adapter={stream.adapter} />);

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Build a website.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const toggle = await screen.findByRole('button', { name: 'Show thinking' });
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Inspect the workspace root.')).toBeVisible();

    stream.nextChunk();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hide thinking' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
    expect(await screen.findByText('Then enumerate the files.', { exact: false })).toBeVisible();

    stream.finish();
    await waitFor(() => {
      expect(screen.getByText('Done.')).toBeVisible();
    });
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
    // Real streaming runtime + userEvent typing: comfortably sub-second when
    // idle, but repeatedly tripped vitest's 5s default on loaded runners.
  }, 20_000);
});
