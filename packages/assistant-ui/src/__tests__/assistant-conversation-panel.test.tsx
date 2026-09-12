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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  onSendActiveInput,
  attachments = false,
  composerDisabled = false,
}: {
  attachments?: boolean;
  composerDisabled?: boolean;
  id: string;
  messages: readonly ThreadMessageLike[];
  onNew: ExternalStoreAdapter<ThreadMessageLike>['onNew'];
  onCancel?: () => Promise<void>;
  onReload?: ExternalStoreAdapter<ThreadMessageLike>['onReload'];
  onEdit?: ExternalStoreAdapter<ThreadMessageLike>['onEdit'];
  running?: boolean;
  onExitPlanMode?: () => void;
  onSendActiveInput?: (input: { readonly id: string; readonly text: string }) => Promise<void>;
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
      {...(attachments ? { attachmentsAvailability: { state: 'enabled' as const } } : {})}
      isComposerDisabled={composerDisabled}
      label={id}
      onSendActiveInput={onSendActiveInput}
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

  it.each(['pending', 'delivered'])(
    'shows the persisted %s child input acknowledgement',
    (state) => {
      render(
        <TooltipProvider>
          <Conversation
            id="Cedar"
            messages={[
              {
                content: 'Inspect file',
                id: 'human',
                metadata: { custom: { brainstrikeChildInputDelivery: state } },
                role: 'user',
              },
            ]}
            onNew={async () => {}}
          />
        </TooltipProvider>
      );
      expect(
        screen.getByText(
          state === 'pending'
            ? 'Delivery unconfirmed. This input will not be replayed automatically.'
            : 'Accepted by child'
        )
      ).toHaveAttribute('role', 'status');
    }
  );

  it('sends an active child draft once, retains failed input, and retries the same request id explicitly', async () => {
    const onNew = vi.fn(async () => {});
    const send = vi
      .fn<(input: { readonly id: string; readonly text: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Delivery was interrupted'))
      .mockResolvedValue(undefined);
    render(
      <TooltipProvider>
        <Conversation
          id="Cedar"
          messages={[message('Reading')]}
          onNew={onNew}
          onSendActiveInput={send}
          running
        />
      </TooltipProvider>
    );
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'Check another file');
    await user.click(screen.getByRole('button', { name: 'Send to child' }));
    await expect(screen.findByText('Delivery was interrupted')).resolves.toHaveAttribute(
      'role',
      'alert'
    );
    expect(input).toHaveValue('Check another file');
    await user.click(input);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveValue(''));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    expect(onNew).not.toHaveBeenCalled();
    expect(useFollowUpQueueStore.getState().queuedByThread).toEqual({});
  });

  it('lets the user discard an unconfirmed draft and explicitly compose a fresh request', async () => {
    const send = vi
      .fn<(input: { id: string; text: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Inspect the child before sending again.'))
      .mockResolvedValue(undefined);
    render(
      <TooltipProvider>
        <Conversation
          id="Cedar"
          messages={[message('Reading')]}
          onNew={async () => {}}
          onSendActiveInput={send}
          running
        />
      </TooltipProvider>
    );
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'Inspect again');
    await user.click(screen.getByRole('button', { name: 'Send to child' }));
    await screen.findByText('Inspect the child before sending again.');
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(input).toHaveValue('');
    expect(send).toHaveBeenCalledOnce();
    await user.type(input, 'Inspect again');
    await user.click(screen.getByRole('button', { name: 'Send to child' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].id).not.toBe(send.mock.calls[1]?.[0].id);
  });

  it('can stop waiting for an acknowledgement without replaying or losing its request identity', async () => {
    const accepted = Promise.withResolvers<void>();
    const send = vi.fn(
      (_input: { readonly id: string; readonly text: string }) => accepted.promise
    );
    render(
      <TooltipProvider>
        <Conversation
          id="Cedar"
          messages={[message('Reading')]}
          onNew={async () => {}}
          onSendActiveInput={send}
          running
        />
      </TooltipProvider>
    );
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'Possibly delivered');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(screen.getByRole('button', { name: 'Send to child' })).toBeEnabled();
    expect(input).toHaveValue('Possibly delivered');
    expect(send).toHaveBeenCalledOnce();
    accepted.resolve();
    await waitFor(() => expect(screen.getByText(/Waiting stopped/)).toBeVisible());
    expect(input).toHaveValue('Possibly delivered');
    await user.click(input);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
  });

  it.each(['idle', 'owner-removed'] as const)(
    'keeps unconfirmed input controls reachable when the child becomes %s',
    async (boundary) => {
      const accepted = Promise.withResolvers<void>();
      let transportSettled = false;
      const send = vi.fn(async () => {
        await accepted.promise;
        transportSettled = true;
      });
      const onNew = vi.fn(async () => {});
      // Idle completes execution; owner-removed retains the running snapshot
      // but withdraws its transport and explicitly disables the host composer.
      const view = (active: boolean) => (
        <TooltipProvider>
          <Conversation
            composerDisabled={!active && boundary === 'owner-removed'}
            id="Cedar"
            messages={[message(active || boundary === 'owner-removed' ? 'Reading' : 'Completed')]}
            onNew={onNew}
            {...(active || boundary === 'idle' ? { onSendActiveInput: send } : {})}
            running={active || boundary === 'owner-removed'}
          />
        </TooltipProvider>
      );
      const { rerender } = render(view(true));
      const user = userEvent.setup();
      const input = screen.getByRole('textbox', { name: 'Message input' });
      await user.type(input, 'Possibly delivered');
      await user.click(screen.getByRole('button', { name: 'Send to child' }));
      rerender(view(false));
      if (boundary === 'idle') {
        expect(input).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      } else {
        expect(input).toBeDisabled();
      }
      expect(screen.getByText('Sending to child…')).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
      expect(screen.getByTestId('child-input-delivery')).toHaveTextContent(
        'Delivery is unconfirmed'
      );
      expect(input).toHaveValue('Possibly delivered');
      if (boundary === 'idle') {
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
        await user.click(input);
        await user.keyboard('{Enter}');
      }
      expect(send).toHaveBeenCalledOnce();
      expect(onNew).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Discard draft' }));
      expect(input).toHaveValue('');
      expect(screen.queryByTestId('child-input-delivery')).not.toBeInTheDocument();
      await act(async () => {
        accepted.resolve();
        await accepted.promise;
      });
      expect(transportSettled).toBe(true);
      expect(input).toHaveValue('');
      expect(send).toHaveBeenCalledOnce();
      expect(onNew).not.toHaveBeenCalled();
    }
  );

  it.each(['', '   '])(
    'keeps blank rejection %j visible and discardable after idle',
    async (errorMessage) => {
      const accepted = Promise.withResolvers<void>();
      const send = vi.fn(() => accepted.promise);
      const onNew = vi.fn(async () => {});
      const view = (running: boolean) => (
        <TooltipProvider>
          <Conversation
            attachments
            id="Cedar"
            messages={[message('Reading')]}
            onNew={onNew}
            onSendActiveInput={send}
            running={running}
          />
        </TooltipProvider>
      );
      const { rerender } = render(view(true));
      const user = userEvent.setup();
      const input = screen.getByRole('textbox', { name: 'Message input' });
      await user.type(input, 'Possibly delivered');
      await user.click(screen.getByRole('button', { name: 'Send to child' }));
      rerender(view(false));
      await act(async () => {
        accepted.reject(new Error(errorMessage));
        await accepted.promise.catch(() => undefined);
      });
      expect(screen.getByTestId('child-input-delivery')).toHaveTextContent(
        'Child input delivery was not confirmed.'
      );
      const file = new File(['image'], 'receipt.png', { type: 'image/png' });
      expect(fireEvent.paste(input, { clipboardData: { files: [file] } })).toBe(true);
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Discard draft' }));
      expect(input).toHaveValue('');
      expect(onNew).not.toHaveBeenCalled();
    }
  );

  it('isolates an abandoned receipt when the selected conversation key changes', async () => {
    const accepted = Promise.withResolvers<void>();
    let settled = false;
    const send = vi.fn(async () => {
      await accepted.promise;
      settled = true;
    });
    const onNew = vi.fn(async () => {});
    const view = (id: string) => (
      <TooltipProvider>
        <Conversation
          id={id}
          messages={[message('Reading')]}
          onNew={onNew}
          onSendActiveInput={send}
          running
        />
      </TooltipProvider>
    );
    const { rerender } = render(view('Cedar'));
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Cedar instruction');
    await user.click(screen.getByRole('button', { name: 'Send to child' }));
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(screen.getByTestId('child-input-delivery')).toHaveTextContent('Delivery is unconfirmed');
    rerender(view('Flint'));
    expect(screen.queryByTestId('child-input-delivery')).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.clear(input);
    await user.type(input, 'Flint draft');
    expect(screen.getByRole('button', { name: 'Send to child' })).toBeEnabled();
    await act(async () => {
      accepted.resolve();
      await accepted.promise;
    });
    expect(settled).toBe(true);
    expect(input).toHaveValue('Flint draft');
    expect(screen.queryByTestId('child-input-delivery')).not.toBeInTheDocument();
    expect(onNew).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it('settles a confirmed input after the child stops without replaying it', async () => {
    const accepted = Promise.withResolvers<void>();
    const send = vi.fn(() => accepted.promise);
    const onNew = vi.fn(async () => {});
    const view = (running: boolean) => (
      <TooltipProvider>
        <Conversation
          composerDisabled={!running}
          id="Cedar"
          messages={[message(running ? 'Reading' : 'Completed')]}
          onNew={onNew}
          onSendActiveInput={send}
          running={running}
        />
      </TooltipProvider>
    );
    const { rerender } = render(view(true));
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'Delivered just before completion');
    await user.click(screen.getByRole('button', { name: 'Send to child' }));
    rerender(view(false));
    expect(screen.getByText('Sending to child…')).toBeVisible();
    accepted.resolve();
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByText('Sending to child…')).not.toBeInTheDocument();
    expect(screen.queryByTestId('child-input-delivery')).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledOnce();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('requires explicit discard before changed text can replace an unconfirmed request', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Delivery unconfirmed'));
    render(
      <TooltipProvider>
        <Conversation
          id="Cedar"
          messages={[message('Reading')]}
          onNew={async () => {}}
          onSendActiveInput={send}
          running
        />
      </TooltipProvider>
    );
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'First instruction');
    await user.keyboard('{Enter}');
    await screen.findByText('Delivery unconfirmed');
    await user.clear(input);
    await user.type(input, 'Replacement instruction');
    await user.keyboard('{Enter}');
    expect(send).toHaveBeenCalledOnce();
    expect(screen.getByText(/earlier input is unconfirmed/)).toHaveTextContent('Discard');
    expect(input).toHaveValue('Replacement instruction');
  });

  it('keeps the active composer editable and preserves a changed draft during acknowledgement', async () => {
    const accepted = Promise.withResolvers<void>();
    const send = vi.fn(
      (_input: { readonly id: string; readonly text: string }) => accepted.promise
    );
    render(
      <TooltipProvider>
        <Conversation
          attachments
          id="Cedar"
          messages={[message('Reading')]}
          onNew={async () => {}}
          onSendActiveInput={send}
          running
        />
      </TooltipProvider>
    );
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'First input');
    await user.keyboard('{Enter}');
    expect(send).toHaveBeenCalledOnce();
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Next input');
    accepted.resolve();
    await waitFor(() => expect(screen.queryByText('Sending to child…')).not.toBeInTheDocument());
    expect(input).toHaveValue('Next input');
    expect(send).toHaveBeenCalledOnce();
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
