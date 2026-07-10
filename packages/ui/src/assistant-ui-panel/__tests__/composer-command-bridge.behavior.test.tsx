import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { useLocalRuntime } from '@assistant-ui/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const run = vi.fn(async function* () {
  yield { content: [] };
});
const NOOP_ADAPTER: ChatModelAdapter = { run };

vi.mock('../data-stream-runtime', () => ({
  useBrainstrikeDataStreamRuntime: () => useLocalRuntime(NOOP_ADAPTER),
}));
vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assistant-ui/styles/index.css', () => ({}));
vi.mock('../local-runtime-adapter', () => ({
  createLocalModelAdapter: vi.fn(() => ({ run: vi.fn() })),
  disposeLocalBackend: vi.fn().mockResolvedValue(undefined),
  hasDesktopLlmHost: vi.fn(() => false),
}));

import { AssistantUiPanel, type ComposerDraftCommand } from '../assistant-ui-panel';

function renderPanel(
  command: ComposerDraftCommand | undefined,
  callbacks: {
    onApplied: (id: string) => void;
    onTextChange: (text: string) => void;
  }
) {
  return render(
    <AssistantUiPanel
      composerDraftCommand={command}
      onComposerDraftCommandApplied={callbacks.onApplied}
      onComposerTextChange={callbacks.onTextChange}
      pickerModels={[]}
      pickerProviders={[]}
    />
  );
}

describe('assistant composer command bridge', () => {
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
      <AssistantUiPanel
        composerDraftCommand={command}
        onComposerDraftCommandApplied={onApplied}
        onComposerTextChange={onTextChange}
        pickerModels={[]}
        pickerProviders={[]}
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
      <AssistantUiPanel
        composerDraftCommand={{ id: 'append-1', mode: 'append', text: 'Cite exact evidence.' }}
        onComposerDraftCommandApplied={onApplied}
        onComposerTextChange={onTextChange}
        pickerModels={[]}
        pickerProviders={[]}
      />
    );

    await waitFor(() => expect(input).toHaveValue('Existing draft\n\nCite exact evidence.'));
    expect(onApplied).toHaveBeenCalledWith('append-1');
    expect(run).not.toHaveBeenCalled();
  });
});
