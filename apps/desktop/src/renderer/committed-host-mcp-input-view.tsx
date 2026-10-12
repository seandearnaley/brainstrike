import type { McpElicitationPresentationWire } from '@brainstrike/assistant-contract';
import { McpElicitationDialog } from '@brainstrike/settings-ui/settings/tools/mcp-elicitation-dialog';
import { mcpTaskInputCanceller } from '@brainstrike/settings-ui/settings/tools/mcp-task-input-canceller';
import { useMcpElicitationCapability } from '@brainstrike/settings-ui/settings/tools/use-mcp-elicitation-capability';
import { Button } from '@brainstrike/ui';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import type { CommittedHostMcpInput, CommittedMcpInputSnapshot } from './committed-host-mcp-input';

type CurrentInput = NonNullable<CommittedMcpInputSnapshot['input']>;

function statusMessage(connected: boolean, status: CurrentInput['status']): string {
  if (!connected) {
    return 'Reconnect to review the server input.';
  }
  switch (status) {
    case 'accepted':
      return 'Input sent. Waiting for the server.';
    case 'unknown':
      return 'The server input delivery outcome is unknown.';
    case 'retired':
      return 'This server input is no longer available.';
    default:
      return 'Loading server input…';
  }
}

/** Existing consent controls submit only to the attached Core input owner. */
export function CommittedHostMcpInputView({
  input,
}: {
  readonly input: CommittedHostMcpInput;
}): ReactElement | null {
  const snapshot = useSyncExternalStore(input.subscribe, input.getSnapshot, input.getSnapshot);
  const { tasks: taskBridge } = useMcpElicitationCapability();
  // Cancelling the input's task from this dialog keeps the dialog to report that
  // outcome once Core retires the input. Other retirements (Stop, a server
  // withdrawal) show the status line instead.
  const [taskCancelled, setTaskCancelled] = useState<McpElicitationPresentationWire>();
  const current = snapshot.input;
  if (snapshot.error) {
    return <div role="alert">{snapshot.error}</div>;
  }
  if (!current) {
    return null;
  }
  const live =
    snapshot.connected && current.status === 'requested' ? current.presentation : undefined;
  const retired =
    current.status === 'retired' && taskCancelled?.id === current.address.interactionId
      ? taskCancelled
      : undefined;
  const presentation = live ?? retired;
  if (presentation) {
    // Kept while retired, so the pending task action stays mounted to report its outcome.
    const canceller = mcpTaskInputCanceller(presentation, taskBridge);
    return (
      <McpElicitationDialog
        key={current.address.interactionId}
        {...(canceller
          ? {
              onCancelTask: async (): Promise<void> => {
                setTaskCancelled(presentation);
                await canceller();
              },
            }
          : {})}
        onDismissRetired={() => input.dismiss()}
        onSettle={(answer) => input.settle(answer)}
        presentation={presentation}
        {...(retired ? { retiredCode: current.status } : {})}
        taskCancellationUnavailable={
          live !== undefined && !canceller && current.request.taskId !== undefined
        }
      />
    );
  }
  return (
    <div aria-live="polite" role="status">
      {statusMessage(snapshot.connected, current.status)}
      {current.status === 'unknown' || current.status === 'retired' ? (
        <Button onClick={() => input.dismiss()} variant="ghost">
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}
