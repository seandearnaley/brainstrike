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
import { Harness } from './assistant-activity-timeline-fixtures';

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
  it('auto-opens while reasoning streams and settles collapsed once the part completes', async () => {
    const user = userEvent.setup();
    const stream = createStreamingReasoningAdapter();

    render(<StreamingReasoningHarness adapter={stream.adapter} />);

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Build a website.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // No click: the streaming block is open on its own.
    const toggle = await screen.findByRole('button', { name: 'Hide thinking' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Inspect the workspace root.')).toBeVisible();

    // The runtime finalizes a part's `status` to `complete` the moment a
    // LATER part starts streaming (verified against the real local runtime;
    // also the premise `assistant-activity-parts.test.tsx`'s "keeps
    // completed reasoning static while a tool call in the same group is
    // running" already pins). The tool call in this chunk therefore settles
    // the reasoning part immediately — the block follows `isStreaming` back
    // down in the same render, it does not wait for the whole turn to finish.
    stream.nextChunk();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show thinking' })).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });
    expect(
      screen.queryByText('Then enumerate the files.', { exact: false })
    ).not.toBeInTheDocument();

    stream.finish();
    await waitFor(() => {
      expect(screen.getByText('Done.')).toBeVisible();
    });
    // Stays settled collapsed: no manual toggle happened, and the part was
    // already complete before the turn finished. The activity group itself
    // auto-collapses once done (pre-existing, unrelated
    // `AssistantActivityGroup` behavior), which hides its body from the
    // accessibility tree — `getByTestId` reads the toggle's attributes
    // regardless, the same way the hydrated-message tests in
    // assistant-activity-parts.test.tsx already do.
    const settledToggle = screen.getByTestId('local-chain-of-thought');
    expect(settledToggle).toHaveAttribute('aria-expanded', 'false');
    expect(settledToggle).toHaveAttribute('aria-label', 'Show thinking');
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
    // Real streaming runtime + userEvent typing: comfortably sub-second when
    // idle, but repeatedly tripped vitest's 5s default on loaded runners.
  }, 20_000);

  it('a manual close during streaming sticks after the turn finishes', async () => {
    const user = userEvent.setup();
    const stream = createStreamingReasoningAdapter();

    render(<StreamingReasoningHarness adapter={stream.adapter} />);

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Build a website.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const toggle = await screen.findByRole('button', { name: 'Hide thinking' });
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Show thinking' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    stream.nextChunk();
    stream.finish();
    await waitFor(() => {
      expect(screen.getByText('Done.')).toBeVisible();
    });
    // The manual close sticks: settling collapsed anyway would be
    // indistinguishable, but re-opening (following `isStreaming` up) would not.
    // The activity group itself auto-collapses once done (pre-existing,
    // unrelated `AssistantActivityGroup` behavior), which hides its body
    // from the accessibility tree — `getByTestId` reads the toggle's
    // attributes regardless, the same way the hydrated-message tests in
    // assistant-activity-parts.test.tsx already do.
    expect(screen.getByTestId('local-chain-of-thought')).toHaveAttribute('aria-expanded', 'false');
  }, 20_000);

  it('discloses each reasoning part independently within one group', async () => {
    const user = userEvent.setup();
    const neverRun = {
      async run() {
        throw new Error('Hydration must not invoke a model.');
      },
    };
    const content = [
      { text: 'First reasoning segment.', type: 'reasoning' as const },
      {
        args: {},
        argsText: '{}',
        result: { ok: true },
        toolCallId: 'mid',
        toolName: 'tool_mid',
        type: 'tool-call' as const,
      },
      { text: 'Second reasoning segment.', type: 'reasoning' as const },
    ];

    render(<Harness adapter={neverRun} initialMessages={[{ content, role: 'assistant' }]} />);

    // The activity group itself starts collapsed for a hydrated (non-running)
    // message; expand it so the reasoning toggles inside are clickable, not
    // merely present.
    await user.click(await screen.findByRole('button', { name: 'Expand activity' }));

    const toggles = await screen.findAllByTestId('local-chain-of-thought');
    expect(toggles).toHaveLength(2);
    const [firstToggle, secondToggle] = toggles;
    if (!(firstToggle && secondToggle)) {
      throw new Error('Expected two reasoning toggles.');
    }

    await user.click(firstToggle);
    expect(screen.getByText('First reasoning segment.')).toBeVisible();
    expect(screen.queryByText('Second reasoning segment.')).not.toBeInTheDocument();

    await user.click(secondToggle);
    expect(screen.getByText('Second reasoning segment.')).toBeVisible();
    // Opening the second block did not close the first.
    expect(screen.getByText('First reasoning segment.')).toBeVisible();
  });
});
