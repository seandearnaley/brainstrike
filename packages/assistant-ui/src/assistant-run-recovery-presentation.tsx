import type { useAssistantServerRunSession } from './use-assistant-server-run-session';

type ServerRunSession = ReturnType<typeof useAssistantServerRunSession>;

export function AssistantRunRecoveryStatus({ session }: { readonly session: ServerRunSession }) {
  return (
    <>
      {session.isRecovering ? (
        <div aria-live="polite" className="px-4 py-2 text-muted-foreground text-sm" role="status">
          Reconnecting to the assistant run…
        </div>
      ) : null}
      {session.recoveryError ? (
        <div className="mx-4 my-2 rounded-md border border-destructive/50 p-3 text-sm" role="alert">
          <span>Could not reconnect to the assistant run: {session.recoveryError.message}</span>
          <button className="ml-3 underline" onClick={session.retryRecovery} type="button">
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}
