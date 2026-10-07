import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import { DEFAULT_THREAD_TITLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import {
  type AssistantMemoryThread,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
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
import { connectDesktopAgentHost } from './agent-host-client';
import {
  type CommittedHostConversation,
  createCommittedHostConversation,
} from './committed-host-conversation';
import { readDesktopHostModel } from './desktop-host-configuration';
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

/** Transient display projection of the owner's committed identity and timestamps. */
function projectThread(
  threadId: string,
  resourceId: string,
  rows: readonly HostLogRow[]
): AssistantMemoryThread {
  const started = rows.find((row) => row.event.type === 'thread.started');
  if (started?.ts === undefined) {
    throw new Error('Host thread has no committed creation timestamp');
  }
  const latest = rows.findLast(
    (row) =>
      row.event.type !== 'workspace.updated' &&
      !(row.event.type === 'command.accepted' && row.event.method === 'thread/workspace/set')
  );
  return {
    createdAt: new Date(started.ts),
    id: threadId,
    resourceId,
    title: DEFAULT_THREAD_TITLE,
    updatedAt: new Date(latest?.ts ?? started.ts),
  };
}

function createWindowThreadCapability(): AssistantThreadHostCapability {
  let connecting: Promise<HostClient> | undefined;
  let closing: Promise<void> | undefined;
  let catalogLoaded = false;
  const threads = new Map<string, HostClient>();
  const close = (): Promise<void> => {
    const admitted = connecting;
    closing ??= (async () => {
      if (admitted) {
        const [result] = await Promise.allSettled([admitted]);
        if (result?.status === 'fulfilled') {
          await result.value.close();
          await result.value.closed;
        }
      }
      threads.clear();
    })();
    return closing;
  };
  const client = (): Promise<HostClient> => {
    if (closing) {
      return Promise.reject(new Error('The desktop host view is closing'));
    }
    if (!connecting) {
      // The actual frame owns this client. Main joins its relay on navigation,
      // renderer loss and shutdown; React presentation replay owns no transport.
      window.addEventListener(
        'beforeunload',
        () => {
          void close();
        },
        { once: true }
      );
      connecting = connectDesktopAgentHost();
    }
    return connecting;
  };
  const listThreads = async (resourceId: string): Promise<readonly AssistantMemoryThread[]> => {
    const host = await client();
    const catalog = await host.request('thread/list', {});
    const projected = await Promise.all(
      catalog.threads.map(async ({ threadId }) => {
        const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
        threads.set(threadId, host);
        return projectThread(threadId, resourceId, rows);
      })
    );
    catalogLoaded = true;
    return projected;
  };
  const threadClient = async (threadId: string): Promise<HostClient | undefined> => {
    if (!(catalogLoaded || threads.has(threadId))) {
      await listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
    }
    return threads.get(threadId);
  };
  return {
    createThread: async (resourceId) => {
      const host = await client();
      const { threadId } = await host.request('thread/start', { commandId: crypto.randomUUID() });
      const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
      threads.set(threadId, host);
      return projectThread(threadId, resourceId, rows);
    },
    listThreads,
    renderThread: (threadId) => {
      const host = threads.get(threadId);
      // Persisted tabs render before catalog hydration. The observed legacy
      // Mastra initialization for these SQLite-owned IDs must not claim them.
      if (!(host || catalogLoaded)) {
        return <div role="status">Loading assistant threads…</div>;
      }
      return host ? <HostThread client={host} threadId={threadId} /> : undefined;
    },
    workspaceRepository: (history) => {
      const getThreadWorkspace = async (threadId: string) => {
        const host = await threadClient(threadId);
        return host
          ? (await host.request('thread/workspace/read', { threadId })).snapshot
          : history.getThreadWorkspace(threadId);
      };
      return {
        getThreadWorkspace,
        getThreadWorkspaces: async (threadIds) => {
          const snapshots = await Promise.all(
            threadIds.map(async (id) => [id, await getThreadWorkspace(id)] as const)
          );
          return new Map(
            snapshots.flatMap(([id, snapshot]) => (snapshot ? [[id, snapshot] as const] : []))
          );
        },
        setThreadWorkspace: async (threadId, resourceId, snapshot) => {
          const host = await threadClient(threadId);
          if (!host) {
            return history.setThreadWorkspace(threadId, resourceId, snapshot);
          }
          if (resourceId !== WORKSPACE_MEMORY_RESOURCE_ID) {
            throw new Error('The host thread belongs to the workspace resource');
          }
          await host.request('thread/workspace/set', {
            commandId: crypto.randomUUID(),
            snapshot: WorkspaceSnapshotSchema.parse(snapshot),
            threadId,
          });
        },
      };
    },
  };
}

// One lazy client capability per actual renderer frame, independent of React replay.
const windowThreadCapability = createWindowThreadCapability();

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
