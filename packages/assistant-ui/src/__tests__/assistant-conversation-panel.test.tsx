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
import {
  TOOL_SUSPEND_DATA_NAME,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import { resetFollowUpQueueStore, useFollowUpQueueStore } from '../follow-up-queue-store';
import { useRewindComposerStore } from '../rewind-composer-store';
import { RewindProvider } from '../rewind-context';
import { ToolResultRendererProvider } from '../tool-result-renderer-context';
import type { ToolResultRenderer } from '../use-tool-result-renderers';

function Conversation({
  id,
  messages,
  onNew,
  onCancel,
  onReload,
  onEdit,
  running = false,
  onExitPlanMode,
}: {
  id: string;
  messages: readonly ThreadMessageLike[];
  onNew: ExternalStoreAdapter<ThreadMessageLike>['onNew'];
  onCancel?: () => Promise<void>;
  onReload?: ExternalStoreAdapter<ThreadMessageLike>['onReload'];
  onEdit?: ExternalStoreAdapter<ThreadMessageLike>['onEdit'];
  running?: boolean;
  onExitPlanMode?: () => void;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (value) => value,
    isRunning: running,
    messages,
    onNew,
    ...(onCancel ? { onCancel } : {}),
    ...(onReload ? { onReload } : {}),
    ...(onEdit ? { onEdit } : {}),
  });
  return (
    <AssistantConversationPanel
      label={id}
      runtime={runtime}
      threadKey={id}
      {...(onExitPlanMode
        ? { planMode: { enabled: true, onExit: onExitPlanMode, onToggle: () => undefined } }
        : {})}
    />
  );
}

const message = (text: string): ThreadMessageLike => ({
  content: [{ text, type: 'text' }],
  id: 'same-native-message-id',
  role: 'assistant',
});

describe('shared conversation panel', () => {
  afterEach(() => {
    cleanup();
    resetFollowUpQueueStore();
    useRewindComposerStore.getState().consume();
  });

  it('does not inherit the parent rewind capability', () => {
    const requestRewind = vi.fn();
    useRewindComposerStore.getState().requestComposerText('Parent rewind prompt');
    render(
      <TooltipProvider>
        <RewindProvider value={{ requestRewind }}>
          <Conversation
            id="Cedar"
            messages={[{ content: 'Child instructions', id: 'child-user', role: 'user' }]}
            onNew={async () => undefined}
          />
        </RewindProvider>
      </TooltipProvider>
    );
    expect(screen.queryByRole('button', { name: 'Restore to before this message' })).toBeNull();
    expect(requestRewind).not.toHaveBeenCalled();
    expect(useRewindComposerStore.getState().pendingText).toBe('Parent rewind prompt');
    expect(screen.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
  });

  it.each([false, true])('advertises editing only when the runtime supports it (%s)', (canEdit) => {
    const onNew = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
    const onEdit = vi.fn<NonNullable<ExternalStoreAdapter<ThreadMessageLike>['onEdit']>>(
      async () => undefined
    );
    render(
      <TooltipProvider>
        <Conversation
          id="Cedar"
          messages={[{ content: 'Inspect this folder', id: 'user', role: 'user' }]}
          onNew={onNew}
          {...(canEdit ? { onEdit } : {})}
        />
      </TooltipProvider>
    );
    expect(screen.queryAllByRole('button', { name: 'Edit message' })).toHaveLength(canEdit ? 1 : 0);
    expect(onNew).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'advertises regeneration only when the runtime supports it (%s)',
    async (canReload) => {
      const onNew = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
      const onReload = vi.fn<NonNullable<ExternalStoreAdapter<ThreadMessageLike>['onReload']>>(
        async () => undefined
      );
      render(
        <TooltipProvider>
          <Conversation
            id="Cedar"
            messages={[message('Child result.')]}
            onNew={onNew}
            {...(canReload ? { onReload } : {})}
          />
        </TooltipProvider>
      );
      if (!canReload) {
        expect(
          screen.queryByRole('button', { name: 'Regenerate response' })
        ).not.toBeInTheDocument();
        return;
      }
      await userEvent.setup().click(screen.getByRole('button', { name: 'Regenerate response' }));
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(onNew).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'does not dispatch a queued follow-up when inspecting a child (running=%s)',
    async (running) => {
      const onNew = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
      useFollowUpQueueStore.getState().enqueue('Cedar', 'Queued child work');
      const view = (isRunning: boolean) => (
        <TooltipProvider>
          <Conversation
            id="Cedar"
            messages={[message('Child result.')]}
            onNew={onNew}
            running={isRunning}
          />
        </TooltipProvider>
      );
      const { rerender, unmount } = render(view(running));
      expect(onNew).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: 'Queue message to send after this run' })
      ).not.toBeInTheDocument();
      rerender(view(false));
      expect(onNew).not.toHaveBeenCalled();
      expect(useFollowUpQueueStore.getState().queuedByThread['Cedar']).toHaveLength(1);
      unmount();
      render(view(false));
      expect(onNew).not.toHaveBeenCalled();
      expect(useFollowUpQueueStore.getState().queuedByThread['Cedar']).toHaveLength(1);
    }
  );
  it('keeps root plan mode when its real runtime approves a forwarded child plan', async () => {
    const onExitPlanMode = vi.fn();
    const onNew = vi.fn<ExternalStoreAdapter<ThreadMessageLike>['onNew']>(async () => undefined);
    const delegation = {
      path: [
        {
          childRuntimeRunId: 'child-run',
          parentRuntimeRunId: 'root-run',
          parentToolCallId: 'delegate-plan',
          personaId: 'probe',
        },
      ],
      toolCallId: 'leaf-plan',
    };
    render(
      <TooltipProvider>
        <Conversation
          id="Root"
          messages={[
            {
              content: [
                {
                  data: {
                    delegation,
                    runId: 'child-run',
                    suspendPayload: {
                      overview: 'Inspect the child result.',
                      steps: [{ title: 'Report the result' }],
                      title: 'Child plan',
                    },
                    toolCallId: 'leaf-plan',
                    toolName: 'brainstrike.submitPlan',
                  },
                  name: TOOL_SUSPEND_DATA_NAME,
                  type: 'data',
                },
              ],
              id: 'forwarded-plan',
              role: 'assistant',
            },
          ]}
          onExitPlanMode={onExitPlanMode}
          onNew={onNew}
        />
      </TooltipProvider>
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: /^approve$/i }));
    expect(onExitPlanMode).not.toHaveBeenCalled();
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew.mock.calls[0]?.[0]).toMatchObject({
      runConfig: {
        custom: {
          [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
            delegation,
            resumeData: { action: 'approved' },
            runId: 'root-run',
            toolCallId: 'delegate-plan',
          },
        },
      },
    });
  });

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
