import type { ReactElement } from 'react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  AssistantConversationPanel,
  type AssistantConversationPanelProps,
} from './assistant-conversation-panel';
import {
  type CommittedAssistantRuntimeOptions,
  useCommittedAssistantRuntime,
} from './use-committed-assistant-runtime';

export type CommittedAssistantConversationProps = Omit<
  AssistantConversationPanelProps,
  'runtime' | 'threadKey'
> &
  Omit<CommittedAssistantRuntimeOptions, 'onCommandError'> & {
    readonly onCommandError?: (cause: unknown) => void;
  };

/** The shipped desktop conversation surface; connection changes never key/remount its transcript. */
export function CommittedAssistantConversation(
  props: CommittedAssistantConversationProps
): ReactElement {
  // A different conversation gets its own vendor runtime/composer. Replacing the
  // transport for this same thread retains scroll, focus and the unsent draft.
  return <BoundCommittedAssistantConversation key={props.store.threadId} {...props} />;
}

function BoundCommittedAssistantConversation({
  store,
  commands,
  adapters,
  onCommandError,
  ...presentation
}: CommittedAssistantConversationProps): ReactElement {
  const [commandError, setCommandError] = useState<string | undefined>();
  const reportCommandError = useCallback(
    (cause: unknown): void => {
      setCommandError(cause instanceof Error ? cause.message : String(cause));
      onCommandError?.(cause);
    },
    [onCommandError]
  );
  const runtime = useCommittedAssistantRuntime({
    adapters,
    commands,
    onCommandError: reportCommandError,
    store,
  });
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const unavailable = snapshot.connection !== 'connected' || snapshot.error !== undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {snapshot.error === undefined ? (
        snapshot.connection === 'connected' ? null : (
          <div aria-live="polite" role="status">
            {snapshot.connection === 'connecting'
              ? 'Connecting to the agent host…'
              : snapshot.connection === 'failed'
                ? 'The agent host connection failed. Reconnect to continue.'
                : 'Agent host disconnected. Reconnect to continue.'}
          </div>
        )
      ) : (
        <div aria-label="Agent host error" role="alert">
          {snapshot.error}
        </div>
      )}
      {commandError === undefined ? null : (
        <div aria-label="Agent command error" role="alert">
          {commandError}
          <button onClick={() => setCommandError(undefined)} type="button">
            Dismiss
          </button>
        </div>
      )}
      <AssistantConversationPanel
        {...presentation}
        disabledReason={
          snapshot.error ??
          (unavailable ? 'The agent host is unavailable.' : presentation.disabledReason)
        }
        runtime={runtime}
        threadKey={store.threadId}
      />
    </div>
  );
}
