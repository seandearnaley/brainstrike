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
  ASSISTANT_THREAD_COLOR_IDS,
  ASSISTANT_THREAD_ICON_IDS,
  type AssistantMemoryThread,
  type AssistantThreadColorId,
  type AssistantThreadIconId,
  type AssistantThreadMetadata,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { connectDesktopAgentHost } from './agent-host-client';
import { HostThreadLedger } from './host-thread-ledger';
import { HostThreadRuns } from './host-thread-runs';

/** Workspace views and binding changes are thread state, not conversation activity. */
const WORKSPACE_COMMANDS = new Set(['thread/workspace/set', 'thread/workspace/binding/update']);
const logger = createLogger('DesktopHostThreads');

/** The catalog's committed title, colour and icon (each absent until set). */
interface HostPresentation {
  readonly color?: string;
  readonly icon?: string;
  readonly title?: string;
}

const isColor = (value: string): value is AssistantThreadColorId =>
  (ASSISTANT_THREAD_COLOR_IDS as readonly string[]).includes(value);
const isIcon = (value: string): value is AssistantThreadIconId =>
  (ASSISTANT_THREAD_ICON_IDS as readonly string[]).includes(value);

/** Committed colour and icon this renderer can draw; an unknown ID is reported, not drawn. */
function presentedMetadata(threadId: string, { color, icon }: HostPresentation) {
  if ((color !== undefined && !isColor(color)) || (icon !== undefined && !isIcon(icon))) {
    logger.warn('Host thread has a colour or icon this renderer cannot draw', {
      color,
      icon,
      threadId,
    });
  }
  return {
    ...(color !== undefined && isColor(color) ? { color } : {}),
    ...(icon !== undefined && isIcon(icon) ? { icon } : {}),
  };
}

/** Transient display projection of the owner's committed identity, binding and timestamps. */
function projectThread(
  threadId: string,
  resourceId: string,
  rows: readonly HostLogRow[],
  presentation: HostPresentation
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
  const metadata = {
    ...(bound?.event.type === 'workspace.binding.updated' ? bound.event.binding : {}),
    ...presentedMetadata(threadId, presentation),
  };
  return {
    createdAt: new Date(started.ts),
    id: threadId,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    resourceId,
    title: presentation.title ?? DEFAULT_THREAD_TITLE,
    updatedAt: new Date(latest?.ts ?? started.ts),
  };
}

/**
 * The host owns the thread workspace binding keys (and colour and icon, through
 * `thread/update`). Any other key (model…) has no host owner yet and is refused
 * here, before a request, rather than reaching a history repository that has
 * no row for this thread.
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
  renderThread: (view: {
    readonly catalogLoaded: boolean;
    readonly host: HostClient | undefined;
    readonly onRunningChange: ((threadId: string, running: boolean) => void) | undefined;
    readonly onTitleCommitted: () => void;
    readonly ledger: HostThreadLedger;
    readonly runs: HostThreadRuns;
    readonly threadId: string;
  }) => ReturnType<AssistantThreadHostCapability['renderThread']>
): AssistantThreadHostCapability & {
  readonly ledger: HostThreadLedger;
  readonly runs: HostThreadRuns;
} {
  const runs = new HostThreadRuns();
  const ledger = new HostThreadLedger();
  const titleListeners = new Set<() => void>();
  const titleCommitted = (): void => {
    for (const listener of titleListeners) {
      listener();
    }
  };
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
      catalog.threads.map(async ({ threadId, ...presentation }) => {
        const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
        threads.set(threadId, host);
        runs.accept(threadId, rows);
        ledger.accept(threadId, rows);
        return projectThread(threadId, resourceId, rows, presentation);
      })
    );
    catalogLoaded = true;
    return projected;
  };
  const threadClient = async (threadId: string): Promise<HostClient | undefined> => {
    const known = threads.get(threadId);
    if (known) {
      return known;
    }
    if (!catalogLoaded) {
      await listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
      return threads.get(threadId);
    }
    // Absence from this window's snapshot is not historical ownership: another
    // client (a window or the CLI) may have created the thread since. Only the
    // host's current catalog decides; a failed read rejects, never defaults.
    const host = await client();
    const catalog = await host.request('thread/list', {});
    if (!catalog.threads.some((thread) => thread.threadId === threadId)) {
      return;
    }
    threads.set(threadId, host);
    return host;
  };
  return {
    createThread: async (resourceId) => {
      const host = await client();
      const { threadId } = await host.request('thread/start', { commandId: crypto.randomUUID() });
      const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
      threads.set(threadId, host);
      return projectThread(threadId, resourceId, rows, {});
    },
    deleteThread: async (threadId) => {
      const host = await client();
      const catalog = await host.request('thread/list', {});
      if (!catalog.threads.some((thread) => thread.threadId === threadId)) {
        return false;
      }
      await host.request('thread/delete', { threadId });
      threads.delete(threadId);
      runs.delete(threadId);
      ledger.delete(threadId);
      return true;
    },
    ledger,
    listThreads,
    ownsThread: async (threadId) => (await threadClient(threadId)) !== undefined,
    renameThread: async (threadId, title) => {
      const host = await threadClient(threadId);
      if (!host) {
        throw new Error('This thread is not owned by the agent host');
      }
      await host.request('thread/update', { commandId: crypto.randomUUID(), threadId, title });
    },
    renderThread: (threadId, _isVisible, onRunningChange) =>
      renderThread({
        catalogLoaded,
        host: threads.get(threadId),
        ledger,
        onRunningChange,
        onTitleCommitted: titleCommitted,
        runs,
        threadId,
      }),
    runs,
    subscribeTitleChanges: (listener) => {
      titleListeners.add(listener);
      return () => titleListeners.delete(listener);
    },
    updateThreadBinding: async (threadId, metadata) => {
      const { color, icon, ...binding } = metadata;
      const patch = Object.keys(binding).length > 0 ? bindingPatch(binding) : undefined;
      const host = await threadClient(threadId);
      if (!host) {
        throw new Error('This thread is not owned by the agent host');
      }
      if (color !== undefined || icon !== undefined) {
        await host.request('thread/update', {
          commandId: crypto.randomUUID(),
          ...(color === undefined ? {} : { color }),
          ...(icon === undefined ? {} : { icon }),
          threadId,
        });
      }
      if (patch) {
        await host.request('thread/workspace/binding/update', {
          commandId: crypto.randomUUID(),
          patch,
          threadId,
        });
      }
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
