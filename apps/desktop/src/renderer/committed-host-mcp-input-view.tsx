import { McpElicitationDialog } from '@brainstrike/settings-ui/settings/tools/mcp-elicitation-dialog';
import { Button } from '@brainstrike/ui';
import { type ReactElement, useSyncExternalStore } from 'react';
import type { CommittedHostMcpInput } from './committed-host-mcp-input';

/** Existing consent controls submit only to the attached Core input owner. */
export function CommittedHostMcpInputView({
  input,
}: {
  readonly input: CommittedHostMcpInput;
}): ReactElement | null {
  const snapshot = useSyncExternalStore(input.subscribe, input.getSnapshot, input.getSnapshot);
  if (snapshot.error) {
    return <div role="alert">{snapshot.error}</div>;
  }
  const current = snapshot.input;
  if (!current) {
    return null;
  }
  if (snapshot.connected && current.status === 'requested' && current.presentation) {
    return (
      <McpElicitationDialog
        key={current.address.interactionId}
        onDismissRetired={() => input.dismiss()}
        onSettle={(answer) => input.settle(answer)}
        presentation={current.presentation}
        taskCancellationUnavailable={current.request.taskId !== undefined}
      />
    );
  }
  return (
    <div aria-live="polite" role="status">
      {snapshot.connected
        ? current.status === 'accepted'
          ? 'Input sent. Waiting for the server.'
          : current.status === 'unknown'
            ? 'The server input delivery outcome is unknown.'
            : current.status === 'retired'
              ? 'This server input is no longer available.'
              : 'Loading server input…'
        : 'Reconnect to review the server input.'}
      {current.status === 'unknown' || current.status === 'retired' ? (
        <Button onClick={() => input.dismiss()} variant="ghost">
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}
