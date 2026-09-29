import '@testing-library/jest-dom/vitest';
import {
  type ChatModelAdapter,
  ExportedMessageRepository,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useLayoutEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

const run = vi.fn(async function* () {
  yield { content: [] };
});
const NOOP_ADAPTER: ChatModelAdapter = { run };

vi.mock('../data-stream-runtime', () => ({
  useBrainstrikeDataStreamRuntime: (options: {
    adapters?: NonNullable<Parameters<typeof useLocalRuntime>[1]>['adapters'];
  }) => useLocalRuntime(NOOP_ADAPTER, { adapters: options.adapters }),
}));
vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
  UserMessageText: () => <div data-testid="markdown-text" />,
}));
vi.mock('@assistant-ui/styles/index.css', () => ({}));
vi.mock('../local-runtime-adapter', () => ({
  acquireLocalBackend: vi.fn(() => () => {}),
  createLocalModelAdapter: vi.fn(() => ({ run: vi.fn() })),
  hasDesktopLlmHost: vi.fn(() => false),
}));

import { AssistantUiPanel } from '../assistant-ui-panel';

const textMessage = (id: string, role: 'assistant' | 'user', text: string): ThreadMessageLike => {
  const message = {
    content: [{ text, type: 'text' }] as const,
    id,
  };
  return role === 'assistant'
    ? { ...message, role, status: { reason: 'stop', type: 'complete' } }
    : { ...message, role };
};

describe('assistant composer history hydration', () => {
  it('cannot send a root revision while a continuation parent is still hydrating', async () => {
    const append = vi.fn<ThreadHistoryAdapter['append']>(async () => undefined);
    let resolveHistory: ((history: ExportedMessageRepository) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<ExportedMessageRepository>((resolve) => {
          resolveHistory = resolve;
        })
    );
    const historyAdapter: ThreadHistoryAdapter = { append, load };
    const firstCommitDisabled = vi.fn<(disabled: boolean) => void>();
    const InitialCommitProbe = ({ children }: { children: ReactNode }) => {
      useLayoutEffect(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message input"]'
        );
        firstCommitDisabled(Boolean(input?.disabled));
      }, []);
      return children;
    };

    render(
      <InitialCommitProbe>
        <AssistantUiPanel historyAdapter={historyAdapter} pickerModels={[]} pickerProviders={[]} />
      </InitialCommitProbe>,
      { wrapper: TooltipProvider }
    );
    expect(firstCommitDisabled.mock.calls).toEqual([[true]]);

    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(input).toBeDisabled());
    expect(send).toBeDisabled();

    fireEvent.change(input, { target: { value: 'Must not become another root' } });
    fireEvent.click(send);
    expect(append).not.toHaveBeenCalled();

    resolveHistory?.(
      ExportedMessageRepository.fromBranchableArray(
        [
          { message: textMessage('user-1', 'user', 'First'), parentId: null },
          { message: textMessage('assistant-1', 'assistant', 'First reply'), parentId: 'user-1' },
          { message: textMessage('user-2', 'user', 'Second'), parentId: 'assistant-1' },
          { message: textMessage('assistant-2', 'assistant', 'Second reply'), parentId: 'user-2' },
        ],
        { headId: 'assistant-2' }
      )
    );

    await waitFor(() => expect(input).toBeEnabled());
    const user = userEvent.setup();
    await user.type(input, 'Third');
    await user.click(send);

    await waitFor(() => {
      const appendedUser = append.mock.calls
        .map(([item]) => item)
        .find((item) => item.message.role === 'user');
      expect(appendedUser?.parentId).toBe('assistant-2');
    });
  });
});
