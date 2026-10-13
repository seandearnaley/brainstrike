import type React from 'react';
import type { useWebAssistantRequestSession } from './use-web-assistant-request-session';

type ServerRunSession = ReturnType<typeof useWebAssistantRequestSession>;

export function WebAssistantRequestStatus({
  session,
}: {
  readonly session: ServerRunSession;
}): React.JSX.Element {
  return (
    <>
      {session.isRecovering ? (
        <div aria-live="polite" className="px-4 py-2 text-muted-foreground text-sm" role="status">
          Finishing the assistant request…
        </div>
      ) : null}
      {session.recoveryError ? (
        <div className="mx-4 my-2 rounded-md border border-destructive/50 p-3 text-sm" role="alert">
          <span>Could not finish the assistant request: {session.recoveryError.message}</span>
          <button className="ml-3 underline" onClick={session.retryRecovery} type="button">
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}
