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
import { render, screen, waitFor, within } from '@testing-library/react';
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

    // The activity group starts collapsed even while active (BST-1677 wave
    // 3): expand it before reaching the reasoning toggle inside its body.
    // Expanding sticks for the mounted group, so the block stays reachable
    // through the rest of this test.
    await user.click(await screen.findByRole('button', { name: 'Expand activity' }));

    // No click on the reasoning toggle itself: the streaming block is open
    // on its own.
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
    // `ActivityTrace` behavior), which hides its body from the
    // accessibility tree — `getByTestId` reads the toggle's attributes
    // regardless, the same way the hydrated-message tests in
    // assistant-activity-parts.test.tsx already do.
    const settledToggle = screen.getByTestId('local-chain-of-thought');
    expect(settledToggle).toHaveAttribute('aria-expanded', 'false');
    expect(settledToggle).toHaveAttribute('aria-label', 'Show thinking');
    // Past tense once the block settled (BST-1679): the pill reads "Thinking"
    // only while its own part streams. No reasoning duration is derivable in
    // this harness (no run events), so it stays the bare verb — assert the
    // exact label, not a substring (e.g. a stray "Thoughts" would also pass
    // `toHaveTextContent`).
    expect(
      within(screen.getByTestId('assistant-reasoning-indicator')).getByText('Thought', {
        exact: true,
      })
    ).toBeInTheDocument();
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

    // The activity group starts collapsed even while active (BST-1677 wave
    // 3): expand it before reaching the reasoning toggle inside its body.
    await user.click(await screen.findByRole('button', { name: 'Expand activity' }));

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
    // unrelated `ActivityTrace` behavior), which hides its body
    // from the accessibility tree — `getByTestId` reads the toggle's
    // attributes regardless, the same way the hydrated-message tests in
    // assistant-activity-parts.test.tsx already do.
    expect(screen.getByTestId('local-chain-of-thought')).toHaveAttribute('aria-expanded', 'false');
  }, 20_000);

  it('a manually opened block survives an intervening tool call and the turn finishing (BST-1656)', async () => {
    const user = userEvent.setup();
    const stream = createStreamingReasoningAdapter();

    render(<StreamingReasoningHarness adapter={stream.adapter} />);

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Build a website.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // The activity group starts collapsed even while active (BST-1677 wave
    // 3): expand it before reaching the reasoning toggle inside its body.
    await user.click(await screen.findByRole('button', { name: 'Expand activity' }));

    // The first block auto-opens on its own while it streams. Capture its
    // panel id (`aria-controls`, backed by `useId()`) as a mount fingerprint
    // — a remount hands the block a fresh id, so comparing this value later
    // is how the test tells "same instance, state preserved" apart from
    // "fresh instance that happens to compute the same open/closed value."
    const streamingToggle = await screen.findByRole('button', { name: 'Hide thinking' });
    const panelId = streamingToggle.getAttribute('aria-controls');

    // The tool call in this chunk settles the reasoning part; the block
    // follows `isStreaming` back down and settles collapsed on its own.
    stream.nextChunk();
    const settledToggle = await screen.findByRole('button', { name: 'Show thinking' });
    expect(settledToggle).toHaveAttribute('aria-expanded', 'false');
    expect(settledToggle).toHaveAttribute('aria-controls', panelId);

    // Manually reopen the settled block.
    await user.click(settledToggle);
    const reopenedToggle = screen.getByRole('button', { name: 'Hide thinking' });
    expect(reopenedToggle).toHaveAttribute('aria-expanded', 'true');
    expect(reopenedToggle).toHaveAttribute('aria-controls', panelId);
    expect(screen.getByText('Inspect the workspace root.', { exact: false })).toBeVisible();

    stream.finish();
    await waitFor(() => {
      expect(screen.getByText('Done.')).toBeVisible();
    });
    // The manual open sticks through the turn finishing: it's still the
    // same button — same panel id, so the block never remounted when the
    // tool call's result and the trailing text part arrived — still
    // expanded, and its panel still holds the text (now including the
    // later-arriving segment). The activity group itself auto-collapses
    // once done (pre-existing, unrelated `ActivityTrace`
    // behavior), which hides the panel from the accessibility tree —
    // `toHaveTextContent` reads it regardless, the same way the
    // hydrated-message tests in assistant-activity-parts.test.tsx already
    // do.
    const survivingToggle = screen.getByTestId('local-chain-of-thought');
    expect(survivingToggle).toHaveAttribute('aria-expanded', 'true');
    expect(survivingToggle).toHaveAttribute('aria-label', 'Hide thinking');
    expect(survivingToggle).toHaveAttribute('aria-controls', panelId);
    expect(screen.getByTestId('local-reasoning-part')).toHaveTextContent(
      'Inspect the workspace root. Then enumerate the files.'
    );
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
