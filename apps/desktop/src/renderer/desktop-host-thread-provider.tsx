import type { HostClient } from '@brainstrike/agent-host/browser';
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
} from 'react';
import {
  type CommittedHostConversation,
  createCommittedHostConversation,
} from './committed-host-conversation';
import { readDesktopHostModel } from './desktop-host-configuration';
import { createWindowThreadCapability } from './desktop-host-thread-capability';
import { useDesktopHostPresentation } from './use-desktop-host-presentation';

function HostThread({
  client,
  threadId,
}: {
  readonly client: HostClient;
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
      readConfiguration: () => configuration.current(explorer.getState().currentFolderId),
      readModelId: () => readDesktopHostModel(threadId),
      threadId,
    });
    setConversation(current);
    return () => current.close();
  }, [client, explorer, threadId]);
  return conversation ? (
    <CommittedAssistantConversation
      {...presentation}
      commands={conversation.commands}
      label="Assistant"
      store={conversation.store}
    />
  ) : (
    <div role="status">Connecting to the agent host…</div>
  );
}

// One lazy client capability per actual renderer frame, independent of React replay.
const windowThreadCapability = createWindowThreadCapability((host, threadId, catalogLoaded) => {
  // Persisted tabs render before catalog hydration. The observed legacy
  // Mastra initialization for these SQLite-owned IDs must not claim them.
  if (!(host || catalogLoaded)) {
    return <div role="status">Loading assistant threads…</div>;
  }
  return host ? <HostThread client={host} threadId={threadId} /> : undefined;
});

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
