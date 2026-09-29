import { useAuiState } from '@assistant-ui/react';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import { Button } from '@brainstrike/ui';
import { SquareIcon } from 'lucide-react';
import { useState } from 'react';
import {
  isAssistantToolApprovalRequest,
  isAssistantToolSuspendRequest,
  resolveApprovalRunOutcome,
  resolveSuspendRunOutcome,
} from './tool-decision-run-outcome';

/** Uses the shared thread's actual state, including a persisted pending decision. */
export function ConversationExecutionControls({
  onCancel,
}: {
  readonly onCancel: () => Promise<void>;
}) {
  const available = useAuiState(
    (state) =>
      state.thread.isRunning ||
      Boolean(
        state.thread.messages.some((message) =>
          message.content.some((part) => {
            if (
              part.type !== 'data' ||
              (part.name !== TOOL_APPROVAL_DATA_NAME && part.name !== TOOL_SUSPEND_DATA_NAME)
            ) {
              return false;
            }
            if (!part.data || typeof part.data !== 'object' || 'decisionState' in part.data) {
              return false;
            }
            if (part.name === TOOL_APPROVAL_DATA_NAME) {
              return (
                isAssistantToolApprovalRequest(part.data) &&
                resolveApprovalRunOutcome(state.thread.messages, part.data).state !== 'completed'
              );
            }
            return (
              isAssistantToolSuspendRequest(part.data) &&
              resolveSuspendRunOutcome(state.thread.messages, part.data) !== 'completed'
            );
          })
        )
      )
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (!(available || error)) {
    return null;
  }
  const cancel = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onCancel();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Button
        aria-label="Stop"
        disabled={pending}
        onClick={() => {
          void cancel();
        }}
        size="sm"
        variant="outline"
      >
        <SquareIcon className="size-3.5 fill-current" />
        Stop
      </Button>
      {pending ? <span role="status">Stopping…</span> : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
