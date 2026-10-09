// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fromThreadMessageLike } from '@assistant-ui/react';
import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import { PublishedConversation } from './committed-assistant-test-support';

afterEach(cleanup);

/**
 * BST-1932 (AT-07): an approval-bearing tool call is a standalone card, outside
 * any activity group (BST-1977); its live command output must still stream.
 */
it('streams an approved command’s live output in its standalone card', async () => {
  const source = new PublishedConversation('root', [
    fromThreadMessageLike(
      {
        content: [
          {
            approval: { approved: true, id: 'approval-1' },
            args: { command: "printf 'STREAM_STDOUT_FIRST'" },
            argsText: '{"command":"printf \'STREAM_STDOUT_FIRST\'"}',
            toolCallId: 'command-1',
            toolName: 'brainstrike.executeCommand',
            type: 'tool-call',
          },
          {
            data: { chunk: 'STREAM_STDOUT_FIRST', stream: 'stdout', toolCallId: 'command-1' },
            name: SHELL_OUTPUT_DATA_NAME,
            type: 'data',
          },
        ],
        createdAt: new Date(0),
        id: 'answer',
        role: 'assistant',
      },
      'answer',
      { type: 'running' }
    ),
  ]);
  source.publish({ isRunning: true });
  render(
    <TooltipProvider>
      <CommittedAssistantConversation
        commands={{ onNew: vi.fn() }}
        label="Conversation"
        store={source}
      />
    </TooltipProvider>
  );
  expect(await screen.findByRole('log', { name: 'Live command output' })).toHaveTextContent(
    'STREAM_STDOUT_FIRST'
  );
});
