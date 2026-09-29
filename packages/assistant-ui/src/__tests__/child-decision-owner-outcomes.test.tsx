// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  type CreateAppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalOwnerThread } from '../approval-owner-thread-context';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import type { DecisionRoute } from '../decision-route-context';
import { resetFollowUpQueueStore } from '../follow-up-queue-store';

type StructuredAppendMessage = Exclude<CreateAppendMessage, string>;

function createOwnerThreadStore() {
  let messages: readonly unknown[] = [];
  const listeners = new Set<() => void>();
  return {
    appendFailedAttempt(message: StructuredAppendMessage, attempt: number): void {
      messages = [
        ...messages,
        { ...message, id: `owner-decision-${attempt}` },
        {
          content: [],
          id: `owner-failure-${attempt}`,
          role: 'assistant',
          status: { error: `failure-${attempt}`, reason: 'error', type: 'incomplete' },
        },
      ];
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
    thread: {
      getState: () => ({ messages }),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies ApprovalOwnerThread,
  };
}

function RoutedChild({
  decisionRoute,
  messages,
  ownerThread,
}: {
  readonly decisionRoute: DecisionRoute;
  readonly messages: readonly ThreadMessageLike[];
  readonly ownerThread: ApprovalOwnerThread;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (value) => value,
    isRunning: true,
    messages,
    onNew: async () => undefined,
  });
  return (
    <TooltipProvider>
      <AssistantConversationPanel
        decisionRoute={decisionRoute}
        label="Cedar"
        ownerThread={ownerThread}
        runtime={runtime}
        threadKey="child-thread"
      />
    </TooltipProvider>
  );
}

const dataMessage = (name: string, data: object): ThreadMessageLike => ({
  content: [{ data, name, type: 'data' }],
  id: 'child-pause',
  role: 'assistant',
});

describe('child decisions follow owning-root outcomes', () => {
  afterEach(() => {
    cleanup();
    resetFollowUpQueueStore();
  });

  it.each([false, true])(
    'unlocks approval retries after repeated owner failures (delegated=%s)',
    async (delegated) => {
      const owner = createOwnerThreadStore();
      let attempt = 0;
      const dispatch = vi.fn<DecisionRoute['dispatch']>(async (message) => {
        if (typeof message === 'string') {
          throw new Error('Expected a structured decision.');
        }
        attempt += 1;
        owner.appendFailedAttempt(message, attempt);
        return 'sent';
      });
      const view = render(
        <RoutedChild
          decisionRoute={{ dispatch, queueThreadKey: 'root-thread' }}
          messages={[
            dataMessage(TOOL_APPROVAL_DATA_NAME, {
              args: { path: 'evidence.txt' },
              riskCategory: 'edit',
              ...(delegated
                ? {
                    delegation: {
                      path: [
                        {
                          childRuntimeRunId: 'child-run',
                          parentRuntimeRunId: 'root-run',
                          parentToolCallId: 'parent-call',
                          personaId: 'explore',
                        },
                      ],
                      toolCallId: 'child-tool',
                    },
                  }
                : {}),
              runId: 'child-run',
              toolCallId: 'child-tool',
              toolName: 'workspace.writeFile',
            }),
          ]}
          ownerThread={owner.thread}
        />
      );
      const approve = () => screen.getByRole('button', { name: 'Approve workspace.writeFile' });

      await userEvent.click(approve());
      await waitFor(() => expect(approve()).toBeEnabled());
      await userEvent.click(approve());
      await waitFor(() => expect(approve()).toBeEnabled());
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(owner.listenerCount()).toBe(1);
      view.unmount();
      expect(owner.listenerCount()).toBe(0);
    }
  );

  it.each([false, true])(
    'unlocks typed resume retries after repeated owner failures (delegated=%s)',
    async (delegated) => {
      const owner = createOwnerThreadStore();
      let attempt = 0;
      const dispatch = vi.fn<DecisionRoute['dispatch']>(async (message) => {
        if (typeof message === 'string') {
          throw new Error('Expected a structured decision.');
        }
        attempt += 1;
        owner.appendFailedAttempt(message, attempt);
        return 'sent';
      });
      render(
        <RoutedChild
          decisionRoute={{ dispatch, queueThreadKey: 'root-thread' }}
          messages={[
            dataMessage(TOOL_SUSPEND_DATA_NAME, {
              ...(delegated
                ? {
                    delegation: {
                      path: [
                        {
                          childRuntimeRunId: 'child-run',
                          parentRuntimeRunId: 'root-run',
                          parentToolCallId: 'parent-call',
                          personaId: 'explore',
                        },
                      ],
                      toolCallId: 'child-question',
                    },
                  }
                : {}),
              runId: 'child-run',
              suspendPayload: { question: 'Which directory?' },
              toolCallId: 'child-question',
              toolName: 'brainstrike.askUser',
            }),
          ]}
          ownerThread={owner.thread}
        />
      );
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Your answer' }),
        'packages/app-shell'
      );
      const send = () => screen.getByRole('button', { name: 'Send' });

      await userEvent.click(send());
      await waitFor(() => expect(send()).toBeEnabled());
      await userEvent.click(send());
      await waitFor(() => expect(send()).toBeEnabled());
      expect(dispatch).toHaveBeenCalledTimes(2);
    }
  );
});
