// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  type ExternalStoreAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import {
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import { ToolResultRendererProvider } from '../tool-result-renderer-context';
import type { ToolResultRenderer } from '../use-tool-result-renderers';

function Conversation({
  id,
  messages,
  onNew,
  onCancel,
  running = false,
}: {
  id: string;
  messages: readonly ThreadMessageLike[];
  onNew: ExternalStoreAdapter<ThreadMessageLike>['onNew'];
  onCancel?: () => Promise<void>;
  running?: boolean;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (value) => value,
    isRunning: running,
    messages,
    onNew,
    ...(onCancel ? { onCancel } : {}),
  });
  return <AssistantConversationPanel label={id} runtime={runtime} threadKey={id} />;
}

const message = (text: string): ThreadMessageLike => ({
  content: [{ text, type: 'text' }],
  id: 'same-native-message-id',
  role: 'assistant',
});

describe('shared conversation panel', () => {
  it('routes a child approval through only that conversation runtime', async () => {
    const user = userEvent.setup();
    const rootSend = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
    const childSend = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(
      async () => undefined
    );
    const approval: ThreadMessageLike = {
      content: [
        {
          data: {
            args: { path: 'evidence.txt' },
            runId: 'child-run',
            toolCallId: 'child-tool',
            toolName: 'workspace.writeFile',
          },
          name: TOOL_APPROVAL_DATA_NAME,
          type: 'data',
        },
      ],
      id: 'approval-message',
      role: 'assistant',
    };
    render(
      <TooltipProvider>
        <Conversation id="Root" messages={[message('Parent is waiting.')]} onNew={rootSend} />
        <Conversation id="Cedar" messages={[approval]} onNew={childSend} />
      </TooltipProvider>
    );
    const child = within(screen.getByRole('region', { name: 'Cedar' }));
    await user.click(await child.findByRole('button', { name: /approve workspace.writefile/i }));
    expect(childSend).toHaveBeenCalledTimes(1);
    expect(rootSend).not.toHaveBeenCalled();
    expect(childSend.mock.calls[0]?.[0]).toMatchObject({
      runConfig: {
        custom: {
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'approve',
            runId: 'child-run',
            toolCallId: 'child-tool',
          },
        },
      },
    });
  });

  it('uses the shared rich activity and reasoning components in chronological order', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
    render(
      <TooltipProvider>
        <Conversation
          id="Cedar"
          messages={[
            {
              content: [
                { text: 'Before the search.', type: 'text' },
                { text: 'Compare the evidence.', type: 'reasoning' },
                {
                  args: { query: 'needle' },
                  result: { answer: 'Found evidence.' },
                  toolCallId: 'lookup',
                  toolName: 'search',
                  type: 'tool-call',
                },
                { text: 'After the search.', type: 'text' },
              ],
              id: 'rich',
              role: 'assistant',
            },
          ]}
          onNew={onNew}
        />
      </TooltipProvider>
    );
    const child = within(screen.getByRole('region', { name: 'Cedar' }));
    const before = await child.findByText('Before the search.');
    const after = await child.findByText('After the search.');
    const activity = child.getByTestId('assistant-activity-group');
    expect(
      before.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(activity.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(child.getByRole('button', { name: 'Expand activity' }));
    await user.click(child.getByRole('button', { name: 'Show thinking' }));
    expect(await child.findByText('Compare the evidence.')).toBeVisible();
    await user.click(child.getByRole('button', { name: /expand details/i }));
    expect(child.getByText(/Found evidence/)).toBeVisible();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('preserves host result renderers and errors with the owning conversation identity', async () => {
    const onNew = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
    const renderer: ToolResultRenderer = {
      Component: ({ threadId }) => <p>Artifact belongs to {threadId}</p>,
      kind: 'test-artifact',
      matches: (result) => typeof result === 'object' && result !== null && 'artifact' in result,
    };
    const result: ThreadMessageLike = {
      content: [
        {
          args: {},
          result: { artifact: 'report' },
          toolCallId: 'artifact',
          toolName: 'report',
          type: 'tool-call',
        },
      ],
      id: 'same-result',
      role: 'assistant',
    };
    render(
      <TooltipProvider>
        <ToolResultRendererProvider renderers={[renderer]}>
          <Conversation id="Root" messages={[result]} onNew={onNew} />
          <Conversation
            id="Cedar"
            messages={[
              result,
              {
                content: [],
                id: 'error',
                role: 'assistant',
                status: { error: 'Child execution failed.', reason: 'error', type: 'incomplete' },
              },
            ]}
            onNew={onNew}
          />
        </ToolResultRendererProvider>
      </TooltipProvider>
    );
    const root = within(screen.getByRole('region', { name: 'Root' }));
    const child = within(screen.getByRole('region', { name: 'Cedar' }));
    expect(await root.findByText('Artifact belongs to Root')).toBeInTheDocument();
    expect(await child.findByText('Artifact belongs to Cedar')).toBeInTheDocument();
    expect(child.getByText('Child execution failed.')).toBeVisible();
    expect(root.queryByText('Child execution failed.')).not.toBeInTheDocument();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('isolates visible child snapshots, running state and drafts without starting a model', async () => {
    const user = userEvent.setup();
    const rootSend = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
    const childSend = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(
      async () => undefined
    );
    const stopChild = vi.fn(async () => undefined);
    const rootMessages = [message('Root answer.')];
    const view = (childText: string, running: boolean) => (
      <TooltipProvider>
        <Conversation id="Root" messages={rootMessages} onNew={rootSend} />
        <Conversation
          id="Cedar"
          messages={[message(childText)]}
          onCancel={stopChild}
          onNew={childSend}
          running={running}
        />
      </TooltipProvider>
    );
    const { rerender, unmount } = render(view('Child partial.', true));
    const root = within(screen.getByRole('region', { name: 'Root' }));
    const child = within(screen.getByRole('region', { name: 'Cedar' }));
    expect(await root.findByText('Root answer.')).toBeVisible();
    expect(await child.findByText('Child partial.')).toBeVisible();
    expect(root.queryByText('Child partial.')).not.toBeInTheDocument();
    expect(root.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(child.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await user.type(root.getByRole('textbox', { name: 'Message input' }), 'Root draft');
    await user.click(child.getByRole('button', { name: 'Stop' }));
    expect(stopChild).toHaveBeenCalledTimes(1);
    rerender(view('Child complete.', false));
    expect(await child.findByText('Child complete.')).toBeVisible();
    expect(root.getByRole('textbox', { name: 'Message input' })).toHaveValue('Root draft');
    expect(child.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
    expect(child.getByRole('textbox', { name: 'Message input' }).id).not.toBe(
      root.getByRole('textbox', { name: 'Message input' }).id
    );
    expect(rootSend).not.toHaveBeenCalled();
    expect(childSend).not.toHaveBeenCalled();
    await user.type(child.getByRole('textbox', { name: 'Message input' }), 'Continue Cedar');
    await user.click(child.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(childSend).toHaveBeenCalledTimes(1));
    expect(rootSend).not.toHaveBeenCalled();
    expect(childSend.mock.calls[0]?.[0]).toMatchObject({
      content: [{ text: 'Continue Cedar', type: 'text' }],
    });
    unmount();
    expect(stopChild).toHaveBeenCalledTimes(1);
    expect(childSend).toHaveBeenCalledTimes(1);
  });
});
