/**
 * Conversation Rewind hands the rewound prompt back to the composer
 * (BST-1115, Amendment 2). The confirm modal lives in another package and the
 * button that raised the rewind is unmounted by the rewind itself, so the
 * handoff goes through a module-scope store that the thread surface drains.
 * This proves the drained text reaches the live composer's real input.
 */
import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const run = vi.fn(async function* () {
  yield { content: [] };
});
const NOOP_ADAPTER: ChatModelAdapter = { run };

vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
}));
vi.mock('../user-message-text', () => ({
  UserMessageText: () => <div data-testid="markdown-text" />,
}));

import { useRewindComposerStore } from '../rewind-composer-store';
import { LocalConversationPanel } from './local-conversation-panel';

describe('rewind composer restore', () => {
  it('puts the rewound prompt into the composer and consumes the request', async () => {
    useRewindComposerStore.getState().requestComposerText('Rewound prompt');
    render(
      <LocalConversationPanel
        adapter={NOOP_ADAPTER}
        rewind={{ requestRewind: () => undefined }}
        threadKey="thread-rewind"
      />,
      { wrapper: TooltipProvider }
    );

    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    await waitFor(() => expect(input.value).toBe('Rewound prompt'));
    expect(useRewindComposerStore.getState().pendingText).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
