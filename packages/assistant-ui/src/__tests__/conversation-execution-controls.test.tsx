// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
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
    content: [{ data: { toolCallId: 'write' }, name: TOOL_APPROVAL_DATA_NAME, type: 'data' }],
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
