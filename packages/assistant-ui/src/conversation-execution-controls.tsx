import { useAuiState } from '@assistant-ui/react';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import { Button } from '@brainstrike/ui';
import { SquareIcon } from 'lucide-react';
import { useState } from 'react';

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
        state.thread.messages.at(-1)?.content.some((part) => {
          if (
            part.type !== 'data' ||
            (part.name !== TOOL_APPROVAL_DATA_NAME && part.name !== TOOL_SUSPEND_DATA_NAME)
          ) {
            return false;
          }
          return Boolean(
            part.data && typeof part.data === 'object' && !('decisionState' in part.data)
          );
        })
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
        {pending ? 'Stopping…' : 'Stop'}
      </Button>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
