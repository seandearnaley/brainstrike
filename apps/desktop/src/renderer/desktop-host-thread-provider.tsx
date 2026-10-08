import type { HostClient } from '@brainstrike/agent-host/browser';
import { HostChildConversations, useAssistantRunNotifications } from '@brainstrike/app-shell';
import { AssistantThreadHostContext } from '@brainstrike/app-shell/assistant-thread-host-context';
import { CommittedAssistantConversation, personaLabelForToolName } from '@brainstrike/assistant-ui';
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

/** Committed effects are where a delegation starts or settles a child thread. */
function useCommittedEffectCount(conversation: CommittedHostConversation | undefined): number {
  const source = conversation?.source;
  const read = (): number =>
    source
      ?.getSnapshot()
      .rows.filter(
        ({ event }) => event.type === 'effect.started' || event.type === 'effect.finished'
      ).length ?? 0;
  return useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIPTION, read, read);
}
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

function HostThread({
  client,
  label,
  onRunningChange,
  onTitleCommitted,
  runs,
  threadId,
}: {
  readonly client: HostClient;
  readonly label: string;
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
  const effects = useCommittedEffectCount(conversation);
  useEffect(
    () =>
      conversation ? runs.observe(threadId, conversation.source, onRunNotification) : undefined,
    [conversation, onRunNotification, runs, threadId]
  );
  return conversation ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <HostChildConversations revision={effects} threadId={threadId}>
          <CommittedAssistantConversation
            {...presentation}
            commands={conversation.commands}
            label={label}
            onRunningChange={onRunningChange}
            store={conversation.store}
            workspaceBar={<CommittedWorkspaceControls threadId={threadId} />}
          />
        </HostChildConversations>
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
  ({ catalogLoaded, childPersona, host, onRunningChange, onTitleCommitted, runs, threadId }) => {
    // Persisted tabs render before catalog hydration. The observed legacy
    // Mastra initialization for these SQLite-owned IDs must not claim them.
    if (!(host || catalogLoaded)) {
      return <div role="status">Loading assistant threads…</div>;
    }
    return host ? (
      <HostThread
        client={host}
        // A child's region is named by the persona it runs, like its workspace tab.
        label={childPersona ? personaLabelForToolName(`agent-${childPersona}`) : 'Assistant'}
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
