// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  AssistantRuntimeProvider,
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
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationExecutionControls } from '../conversation-execution-controls';

afterEach(cleanup);

function Controls({
  messages,
  onCancel,
}: {
  messages: readonly ThreadMessageLike[];
  onCancel: () => Promise<void>;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message) => message,
    isRunning: false,
    messages,
    onNew: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ConversationExecutionControls onCancel={onCancel} />
    </AssistantRuntimeProvider>
  );
}

it('keeps a pending child stoppable after another message and removes Stop after resolution', async () => {
  const onCancel = vi.fn(async () => undefined);
  const pending: ThreadMessageLike = {
    content: [
      {
        data: { runId: 'run', toolCallId: 'write', toolName: 'write' },
        name: TOOL_APPROVAL_DATA_NAME,
        type: 'data',
      },
    ],
    id: 'approval',
    role: 'assistant',
  };
  const notice: ThreadMessageLike = {
    content: 'Background work is waiting.',
    id: 'notice',
    role: 'assistant',
  };
  const { rerender } = render(<Controls messages={[pending, notice]} onCancel={onCancel} />);
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(onCancel).toHaveBeenCalledOnce();
  rerender(
    <Controls
      messages={[
        {
          ...pending,
          content: [
            {
              data: { decisionState: 'cancelled', toolCallId: 'write' },
              name: TOOL_APPROVAL_DATA_NAME,
              type: 'data',
            },
          ],
        },
        notice,
      ]}
      onCancel={onCancel}
    />
  );
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
});

it.each([
  [TOOL_APPROVAL_DATA_NAME, TOOL_APPROVAL_RUN_CONFIG_KEY],
  [TOOL_SUSPEND_DATA_NAME, TOOL_SUSPEND_RUN_CONFIG_KEY],
])(
  'removes stale %s Stop after a separate matching completed decision and retains failed decisions',
  (name, key) => {
    const onCancel = vi.fn(async () => undefined);
    const identity = { runId: 'run', toolCallId: 'write', toolName: 'write' };
    const pause: ThreadMessageLike = {
      content: [{ data: identity, name, type: 'data' }],
      id: 'pause',
      role: 'assistant',
    };
    const action: ThreadMessageLike = {
      content: 'Resume',
      id: 'action',
      metadata: {
        custom: { [key]: { ...identity, action: 'approve', resumeData: { approved: true } } },
      },
      role: 'user',
    };
    const failed: ThreadMessageLike = {
      content: 'Failed',
      id: 'result',
      role: 'assistant',
      status: { reason: 'error', type: 'incomplete' },
    };
    const completed: ThreadMessageLike = {
      content: 'Done',
      id: 'result',
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    };
    const { rerender } = render(
      <Controls messages={[pause, action, failed]} onCancel={onCancel} />
    );
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    rerender(<Controls messages={[pause, action, completed]} onCancel={onCancel} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    const other = {
      ...action,
      metadata: { custom: { [key]: { ...identity, action: 'approve', toolCallId: 'sibling' } } },
    };
    rerender(<Controls messages={[pause, other, completed]} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  }
);
