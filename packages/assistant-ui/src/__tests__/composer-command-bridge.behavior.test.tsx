import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { AssistantRuntimeProvider, ComposerPrimitive, useLocalRuntime } from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const run = vi.fn(async function* () {
  yield { content: [] };
});
const NOOP_ADAPTER: ChatModelAdapter = { run };

vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
  UserMessageText: () => <div data-testid="markdown-text" />,
}));

import type { ComposerDraftCommand } from '../assistant-ui-panel';
import { ComposerDraftCommandBridge } from '../composer-draft-command';
import { LocalConversationPanel } from './local-conversation-panel';

function renderPanel(
  command: ComposerDraftCommand | undefined,
  callbacks: {
    onApplied: (id: string) => void;
    onTextChange: (text: string) => void;
  }
) {
  return render(
    <LocalConversationPanel
      adapter={NOOP_ADAPTER}
      composerDraftCommand={command}
      onComposerDraftCommandApplied={callbacks.onApplied}
      onComposerTextChange={callbacks.onTextChange}
    />,
    { wrapper: TooltipProvider }
  );
}

describe('assistant composer command bridge', () => {
  it('isolates composer text updates from a sibling thread-shell render', async () => {
    const user = userEvent.setup();
    let shellRenderCount = 0;
    const ShellProbe = () => {
      shellRenderCount += 1;
      return <div data-testid="thread-shell-probe" />;
    };
    const Harness = () => {
      const runtime = useLocalRuntime(NOOP_ADAPTER);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ShellProbe />
          <ComposerDraftCommandBridge />
          <ComposerPrimitive.Root>
            <ComposerPrimitive.Input aria-label="Isolated message input" />
          </ComposerPrimitive.Root>
        </AssistantRuntimeProvider>
      );
    };

    render(<Harness />);
    const rendersBeforeTyping = shellRenderCount;
    await user.type(screen.getByRole('textbox', { name: 'Isolated message input' }), 'abc');

    expect(shellRenderCount).toBe(rendersBeforeTyping);
  });

  it('replaces the draft exactly once and never sends automatically', async () => {
    const onApplied = vi.fn();
    const onTextChange = vi.fn();
    const command = { id: 'replace-1', mode: 'replace', text: 'Run a rigorous review.' } as const;
    const { rerender } = renderPanel(command, { onApplied, onTextChange });

    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    await waitFor(() => expect(input).toHaveValue('Run a rigorous review.'));
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith('replace-1');
    expect(onTextChange).toHaveBeenCalledWith('Run a rigorous review.');
    expect(run).not.toHaveBeenCalled();

    rerender(
      <LocalConversationPanel
        adapter={NOOP_ADAPTER}
        composerDraftCommand={command}
        onComposerDraftCommandApplied={onApplied}
        onComposerTextChange={onTextChange}
      />
    );
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('appends snippets without erasing the working draft', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    const onTextChange = vi.fn();
    const { rerender } = renderPanel(undefined, { onApplied, onTextChange });
    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    await user.type(input, 'Existing draft');

    rerender(
      <LocalConversationPanel
        adapter={NOOP_ADAPTER}
        composerDraftCommand={{ id: 'append-1', mode: 'append', text: 'Cite exact evidence.' }}
        onComposerDraftCommandApplied={onApplied}
        onComposerTextChange={onTextChange}
      />
    );

    await waitFor(() => expect(input).toHaveValue('Existing draft\n\nCite exact evidence.'));
    expect(onApplied).toHaveBeenCalledWith('append-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('sends a send command exactly once, through the composer', async () => {
    run.mockClear();
    const onApplied = vi.fn();
    const onTextChange = vi.fn();
    const command = { id: 'send-1', mode: 'send', text: 'Plan the release.' } as const;
    const { rerender } = renderPanel(command, { onApplied, onTextChange });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('textbox', { name: 'Message input' })).toHaveValue('');
    expect(await screen.findByText('Plan the release.')).toBeVisible();
    expect(onApplied).toHaveBeenCalledExactlyOnceWith('send-1');

    rerender(
      <LocalConversationPanel
        adapter={NOOP_ADAPTER}
        composerDraftCommand={command}
        onComposerDraftCommandApplied={onApplied}
        onComposerTextChange={onTextChange}
      />
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('holds a send command behind the send gate with its text in the draft', async () => {
    run.mockClear();
    const onApplied = vi.fn();
    const onTextChange = vi.fn();
    const command = { id: 'send-2', mode: 'send', text: 'Plan the release.' } as const;
    const panel = (disabled: boolean) => (
      <LocalConversationPanel
        adapter={NOOP_ADAPTER}
        composerDraftCommand={command}
        isComposerDisabled={disabled}
        onComposerDraftCommandApplied={onApplied}
        onComposerTextChange={onTextChange}
      />
    );
    const { rerender } = render(panel(true), { wrapper: TooltipProvider });
    const input = await screen.findByRole('textbox', { name: 'Message input' });

    await waitFor(() => expect(input).toHaveValue('Plan the release.'));
    expect(run).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();

    rerender(panel(false));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(onApplied).toHaveBeenCalledExactlyOnceWith('send-2');
  });

  it('reports the authoritative empty draft after a send clears the composer', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    const onTextChange = vi.fn();
    run.mockClear();
    renderPanel(undefined, { onApplied, onTextChange });
    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    await user.type(input, 'Send this draft');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(onTextChange).toHaveBeenLastCalledWith('');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
