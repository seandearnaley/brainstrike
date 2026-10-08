import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { AssistantThreadHostCapability } from '@brainstrike/app-shell/assistant-thread-host-context';
import { DEFAULT_THREAD_TITLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  type ThreadWorkspaceBinding,
  ThreadWorkspaceBindingSchema,
} from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import {
  type AssistantMemoryThread,
  type AssistantThreadMetadata,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { connectDesktopAgentHost } from './agent-host-client';

/** Workspace views and binding changes are thread state, not conversation activity. */
const WORKSPACE_COMMANDS = new Set(['thread/workspace/set', 'thread/workspace/binding/update']);

/** Transient display projection of the owner's committed identity, binding and timestamps. */
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
      row.event.type !== 'workspace.binding.updated' &&
      !(row.event.type === 'command.accepted' && WORKSPACE_COMMANDS.has(row.event.method))
  );
  // Each committed binding event carries the full merged binding.
  const bound = rows.findLast((row) => row.event.type === 'workspace.binding.updated');
  return {
    createdAt: new Date(started.ts),
    id: threadId,
    ...(bound?.event.type === 'workspace.binding.updated' ? { metadata: bound.event.binding } : {}),
    resourceId,
    title: DEFAULT_THREAD_TITLE,
    updatedAt: new Date(latest?.ts ?? started.ts),
  };
}

/**
 * The host owns only the thread workspace binding keys. Any other key (colour,
 * icon, model…) has no host owner yet and is refused here, before a request,
 * rather than reaching a history repository that has no row for this thread.
 */
function bindingPatch(metadata: AssistantThreadMetadata): ThreadWorkspaceBinding {
  const parsed = ThreadWorkspaceBindingSchema.safeParse(metadata);
  if (parsed.success) {
    return parsed.data;
  }
  const unowned = parsed.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : []
  );
  throw new Error(
    unowned.length > 0
      ? `Agent host threads do not store ${unowned.join(', ')} yet; nothing was changed.`
      : (parsed.error.issues[0]?.message ?? 'Invalid thread workspace binding')
  );
}

export function createWindowThreadCapability(
  renderThread: (
    host: HostClient | undefined,
    threadId: string,
    catalogLoaded: boolean
  ) => ReturnType<AssistantThreadHostCapability['renderThread']>
): AssistantThreadHostCapability {
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
    deleteThread: async (threadId) => {
      const host = await client();
      const catalog = await host.request('thread/list', {});
      if (!catalog.threads.some((thread) => thread.threadId === threadId)) {
        return false;
      }
      await host.request('thread/delete', { threadId });
      threads.delete(threadId);
      return true;
    },
    listThreads,
    ownsThread: async (threadId) => (await threadClient(threadId)) !== undefined,
    renderThread: (threadId) => renderThread(threads.get(threadId), threadId, catalogLoaded),
    updateThreadBinding: async (threadId, metadata) => {
      const patch = bindingPatch(metadata);
      const host = await threadClient(threadId);
      if (!host) {
        throw new Error('This thread is not owned by the agent host');
      }
      await host.request('thread/workspace/binding/update', {
        commandId: crypto.randomUUID(),
        patch,
        threadId,
      });
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
