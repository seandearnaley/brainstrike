import type { HostClient } from '@brainstrike/agent-host/browser';
import { useAssistantRunNotifications } from '@brainstrike/app-shell';
import { AssistantThreadHostContext } from '@brainstrike/app-shell/assistant-thread-host-context';
import { CommittedAssistantConversation } from '@brainstrike/assistant-ui';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui/shell';
import {
  type ReactElement,
  type ReactNode,
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
import type { WindowHostConnection } from './window-host-connection';

function HostThread({
  client,
  connection,
  onRunningChange,
  onTitleCommitted,
  runs,
  threadId,
}: {
  readonly client: HostClient;
  readonly connection: WindowHostConnection;
  readonly onRunningChange: ((threadId: string, running: boolean) => void) | undefined;
  readonly onTitleCommitted: () => void;
  readonly runs: HostThreadRuns;
  readonly threadId: string;
}): ReactElement {
  const host = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  // The first client creates the conversation; a replacement only reconnects it.
  const firstClient = useRef(client);
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
      client: firstClient.current,
      modelId: '',
      onTitleCommitted,
      readConfiguration: () => configuration.current(explorer.getState().currentFolderId),
      readModelId: () => readDesktopHostModel(threadId),
      threadId,
    });
    setConversation(current);
    return () => current.close();
  }, [explorer, onTitleCommitted, threadId]);
  // A replacement client reconnects this conversation as the connection announces it.
  useEffect(() => {
    if (!conversation) {
      return;
    }
    return connection.subscribe(() => {
      const state = connection.getSnapshot();
      if (state.status === 'connected') {
        conversation.reconnect(state.client);
      }
    });
  }, [connection, conversation]);
  // Badges and OS notifications read this view's committed run state.
  const { onRunNotification } = useAssistantRunNotifications();
  useEffect(
    () =>
      conversation ? runs.observe(threadId, conversation.source, onRunNotification) : undefined,
    [conversation, onRunNotification, runs, threadId]
  );
  return conversation ? (
    <div className="flex h-full min-h-0 flex-col">
      {host.status === 'restarting' ? (
        <div aria-live="polite" role="status">
          Agent host restarting…
        </div>
      ) : null}
      {host.status === 'failed' ? (
        <div role="alert">
          The agent host could not restart: {host.error}
          <button onClick={() => connection.retry()} type="button">
            Reconnect
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <CommittedAssistantConversation
          {...presentation}
          commands={conversation.commands}
          label="Assistant"
          onRunningChange={onRunningChange}
          store={conversation.store}
          workspaceBar={<CommittedWorkspaceControls threadId={threadId} />}
        />
      </div>
      {/* Core-owned MCP input: the dialog portals; status and alerts sit under the conversation. */}
      <CommittedHostMcpInputView input={conversation.mcpInput} />
    </div>
  ) : (
    <div role="status">Connecting to the agent host…</div>
  );
}

// One lazy client capability per actual renderer frame, independent of React replay.
const windowThreadCapability = createWindowThreadCapability(
  ({ catalogLoaded, connection, host, onRunningChange, onTitleCommitted, runs, threadId }) => {
    // Persisted tabs render before catalog hydration. The observed legacy
    // Mastra initialization for these SQLite-owned IDs must not claim them.
    if (!(host || catalogLoaded)) {
      return <div role="status">Loading assistant threads…</div>;
    }
    return host ? (
      <HostThread
        client={host}
        connection={connection}
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
