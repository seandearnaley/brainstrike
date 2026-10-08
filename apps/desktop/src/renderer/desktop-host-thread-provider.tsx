import type { HostClient } from '@brainstrike/agent-host/browser';
import { useAssistantRunNotifications } from '@brainstrike/app-shell';
import { AssistantThreadHostContext } from '@brainstrike/app-shell/assistant-thread-host-context';
import { CommittedAssistantConversation } from '@brainstrike/assistant-ui';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui/shell';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type CommittedHostConversation,
  createCommittedHostConversation,
} from './committed-host-conversation';
import { CommittedHostMcpInputView } from './committed-host-mcp-input-view';
import { CommittedWorkspaceControls } from './committed-workspace-controls';
import { readDesktopHostModel } from './desktop-host-configuration';
import { createWindowThreadCapability } from './desktop-host-thread-capability';
import type { HostThreadRuns } from './host-thread-runs';
import { useDesktopHostPresentation } from './use-desktop-host-presentation';

function HostThread({
  client,
  onRunningChange,
  onTitleCommitted,
  runs,
  threadId,
}: {
  readonly client: HostClient;
  readonly onRunningChange: ((threadId: string, running: boolean) => void) | undefined;
  readonly onTitleCommitted: () => void;
  readonly runs: HostThreadRuns;
  readonly threadId: string;
}): ReactElement {
  const explorer = useFileExplorerStoreContext();
  const { readConfiguration, ...presentation } = useDesktopHostPresentation(threadId);
  const configuration = useRef(readConfiguration);
  useLayoutEffect(() => {
    configuration.current = readConfiguration;
  }, [readConfiguration]);
  const [conversation, setConversation] = useState<CommittedHostConversation>();
  useEffect(() => {
    // Commit-time view ownership survives StrictMode render replay without
    // starting duplicate subscriptions or disposing a still-mounted source.
    const current = createCommittedHostConversation({
      client,
      modelId: '',
      onTitleCommitted,
      readConfiguration: () => configuration.current(explorer.getState().currentFolderId),
      readModelId: () => readDesktopHostModel(threadId),
      threadId,
    });
    setConversation(current);
    return () => current.close();
  }, [client, explorer, onTitleCommitted, threadId]);
  // Badges and OS notifications read this view's committed run state.
  const { onRunNotification } = useAssistantRunNotifications();
  useEffect(
    () =>
      conversation ? runs.observe(threadId, conversation.source, onRunNotification) : undefined,
    [conversation, onRunNotification, runs, threadId]
  );
  // Steer (BST-588): the queue holds the message at its front while Core ends
  // the run after its step in flight; the message then starts the next turn.
  const [steeredRunId, setSteeredRunId] = useState<string>();
  const steer = useCallback(async (): Promise<boolean> => {
    const runId = await conversation?.steer();
    setSteeredRunId(runId);
    return runId !== undefined;
  }, [conversation]);
  return conversation ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <CommittedAssistantConversation
          {...presentation}
          commands={conversation.commands}
          label="Assistant"
          onRunningChange={onRunningChange}
          onSteerActiveRun={steer}
          store={conversation.store}
          workspaceBar={<CommittedWorkspaceControls threadId={threadId} />}
        />
      </div>
      {steeredRunId ? <SteeringStatus runId={steeredRunId} store={conversation.store} /> : null}
      {/* Core-owned MCP input: the dialog portals; status and alerts sit under the conversation. */}
      <CommittedHostMcpInputView input={conversation.mcpInput} />
    </div>
  ) : (
    <div role="status">Connecting to the agent host…</div>
  );
}

/** Visible while the steered run is still the thread's active run. */
function SteeringStatus({
  runId,
  store,
}: {
  readonly runId: string;
  readonly store: CommittedHostConversation['store'];
}): ReactElement | null {
  const activeRunId = useSyncExternalStore(
    store.subscribe,
    () => store.getCommittedView().activeRunId
  );
  return activeRunId === runId ? (
    <div aria-live="polite" className="px-3 py-1 text-muted-foreground text-xs" role="status">
      Steering: stopping after this step, then sending your message…
    </div>
  ) : null;
}

// One lazy client capability per actual renderer frame, independent of React replay.
const windowThreadCapability = createWindowThreadCapability(
  ({ catalogLoaded, host, onRunningChange, onTitleCommitted, runs, threadId }) => {
    // Persisted tabs render before catalog hydration. The observed legacy
    // Mastra initialization for these SQLite-owned IDs must not claim them.
    if (!(host || catalogLoaded)) {
      return <div role="status">Loading assistant threads…</div>;
    }
    return host ? (
      <HostThread
        client={host}
        onRunningChange={onRunningChange}
        onTitleCommitted={onTitleCommitted}
        runs={runs}
        threadId={threadId}
      />
    ) : undefined;
  }
);

/** New roots hydrate from the committed host; existing history keeps its original owner. */
export function DesktopHostThreadProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <AssistantThreadHostContext.Provider value={windowThreadCapability}>
      {children}
    </AssistantThreadHostContext.Provider>
  );
}
