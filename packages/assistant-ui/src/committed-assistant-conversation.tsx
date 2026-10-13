import { isMessageNotSentError } from '@assistant-ui/react';
import { describeBoundaryError } from '@brainstrike/assistant-contract';
import { Button } from '@brainstrike/ui';
import { CircleAlertIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AssistantConversationPanel,
  type AssistantConversationPanelProps,
} from './assistant-conversation-panel';
import type { CommittedAssistantSnapshot } from './committed-assistant-store';
import { LiveShellOutputContext } from './live-shell-outputs';
import { useAssistantThreadRuntimeAdapters } from './use-assistant-thread-runtime-adapters';
import {
  type CommittedAssistantRuntimeOptions,
  useCommittedAssistantRuntime,
  useCommittedAssistantSelector,
} from './use-committed-assistant-runtime';

export type CommittedAssistantConversationProps = Omit<
  AssistantConversationPanelProps,
  'runtime' | 'threadKey'
> &
  Omit<CommittedAssistantRuntimeOptions, 'onCommandError'> & {
    readonly onCommandError?: (cause: unknown) => void;
    /**
     * The owner's reconnection (BST-2004): `'automatic'` while its one automatic
     * attempt runs, or the user's Reconnect once that attempt failed.
     */
    readonly reconnect?: 'automatic' | (() => void);
  };

const UNAVAILABLE = 'The agent host is unavailable.';
const selectConnection = (snapshot: CommittedAssistantSnapshot) => snapshot.connection;
const selectError = (snapshot: CommittedAssistantSnapshot) => snapshot.error;
const selectWithheld = (snapshot: CommittedAssistantSnapshot) => snapshot.observationWithheld;

function connectionNotice(
  connection: CommittedAssistantSnapshot['connection'],
  reconnect: CommittedAssistantConversationProps['reconnect']
): string {
  if (connection === 'connecting') {
    return 'Connecting to the agent host…';
  }
  if (reconnect === 'automatic') {
    return 'Reconnecting to the agent host…';
  }
  return connection === 'failed'
    ? 'The agent host connection failed. Reconnect to continue.'
    : 'Agent host disconnected. Reconnect to continue.';
}

/**
 * A typed failure from another process shows its message and remedy, never its
 * inner cause; a renderer-local error shows its own message.
 */
function commandErrorText(cause: unknown): string {
  return isMessageNotSentError(cause) ? cause.message : describeBoundaryError(cause);
}

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
  reconnect,
  ...presentation
}: CommittedAssistantConversationProps): ReactElement {
  // Owner status only: a committed token publication never re-renders this shell.
  const connection = useCommittedAssistantSelector(store, selectConnection);
  const error = useCommittedAssistantSelector(store, selectError);
  // The host's committed reason replaces the OM line: a withheld run is never shown as active.
  const withheld = useCommittedAssistantSelector(store, selectWithheld);
  const [commandError, setCommandError] = useState<string | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const reportCommandError = useCallback(
    (cause: unknown): void => {
      setCommandError(commandErrorText(cause));
      onCommandError?.(cause);
    },
    [onCommandError]
  );
  const dismissCommandError = (): void => {
    // Dismiss leaves with its alert. Before it unmounts, hand focus to the
    // composer: the conversation's stable input, where the next command
    // (including a refused send's restored draft) is written.
    rootRef.current?.querySelector<HTMLElement>('.aui-composer-input')?.focus();
    setCommandError(undefined);
  };
  const unavailable = connection !== 'connected' || error !== undefined;
  return (
    <LiveShellOutputContext value={store.liveShellOutputs ?? null}>
      <div className="flex h-full min-h-0 flex-col" ref={rootRef}>
        {error === undefined ? (
          connection === 'connected' ? null : (
            <div aria-live="polite" role="status">
              {connectionNotice(connection, reconnect)}
              {typeof reconnect === 'function' ? (
                <button onClick={reconnect} type="button">
                  Reconnect
                </button>
              ) : null}
            </div>
          )
        ) : (
          <div aria-label="Agent host error" role="alert">
            {error}
          </div>
        )}
        {commandError === undefined ? null : (
          // The host's refusal text names the folder and the repair (BST-1990), so
          // it is shown whole, styled as the app's other error notices.
          <div
            aria-label="Agent command error"
            className="mx-3 my-2 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
            role="alert"
          >
            <CircleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-destructive"
            />
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{commandError}</p>
            <Button onClick={dismissCommandError} size="sm" type="button" variant="ghost">
              Dismiss
            </Button>
          </div>
        )}
        <CommittedRuntimePanel
          {...presentation}
          adapters={adapters}
          commands={commands}
          disabledReason={error ?? (unavailable ? UNAVAILABLE : presentation.disabledReason)}
          // A queued follow-up waits out a disconnect: an idle-looking view is not
          // a committed run end until the owner is connected again.
          isReattaching={unavailable}
          onCommandError={reportCommandError}
          {...(withheld ? { omSegment: { kind: 'withheld' as const, reason: withheld } } : {})}
          store={store}
        />
      </div>
    </LiveShellOutputContext>
  );
}

type CommittedRuntimePanelProps = Omit<AssistantConversationPanelProps, 'runtime' | 'threadKey'> &
  CommittedAssistantRuntimeOptions;

/**
 * Hosts the vendor runtime, whose adapter must see every committed publication,
 * so only this subtree re-renders per publication; the wrapper above it reads
 * connection and error state alone. The panel is deliberately not memoized:
 * measured in Chromium (BST-1929), memoizing it moved the vendor's per-token
 * work into Scheduler tasks and widened the per-token tail.
 */
function CommittedRuntimePanel({
  store,
  commands,
  adapters,
  onCommandError,
  ...panel
}: CommittedRuntimePanelProps): ReactElement {
  // The composer stages images only while the presentation offers them; the
  // owner's send command carries them as the user message's attachments.
  const { adapters: attachmentAdapters } = useAssistantThreadRuntimeAdapters(
    undefined,
    panel.attachmentsAvailability !== undefined
  );
  const runtimeAdapters = useMemo(
    () => (adapters || attachmentAdapters ? { ...attachmentAdapters, ...adapters } : undefined),
    [adapters, attachmentAdapters]
  );
  const runtime = useCommittedAssistantRuntime({
    adapters: runtimeAdapters,
    commands,
    onCommandError,
    store,
  });
  // This surface owns the thread's commands, so it owns its follow-up queue.
  return (
    <AssistantConversationPanel
      {...panel}
      ownsFollowUpQueue
      runtime={runtime}
      threadKey={store.threadId}
    />
  );
}
