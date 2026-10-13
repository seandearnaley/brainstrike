import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow, HostResults } from '@brainstrike/agent-host/protocol';
import type { AssistantThreadHostCapability } from '@brainstrike/app-shell/assistant-thread-host-context';
import { resolveChangesBridge } from '@brainstrike/app-shell/changes/availability';
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
import { foldHostCanvases } from '@brainstrike/host-capabilities/canvas-state';
import { createLogger } from '@brainstrike/logging';
import { connectDesktopAgentHost } from './agent-host-client';
import { createDesktopHostConnection, type DesktopHostConnection } from './desktop-host-connection';
import { createHostRewindPort } from './host-rewind-port';
import { HostThreadCanvases } from './host-thread-canvases';
import { HostThreadLedger } from './host-thread-ledger';
import { HostThreadRuns } from './host-thread-runs';

const logger = createLogger('DesktopHostThreads');

type CatalogEntry = Pick<
  HostResults['thread/list']['threads'][number],
  'binding' | 'color' | 'createdAt' | 'damage' | 'icon' | 'threadId' | 'title' | 'updatedAt'
>;

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

/**
 * Transient display projection of the owner's catalog entry: identity, binding
 * and timestamps. A damaged thread stays listed, its damage shown as a read failure.
 */
function projectThread(
  resourceId: string,
  { binding, createdAt, damage, threadId, updatedAt, ...presentation }: CatalogEntry
): AssistantMemoryThread {
  const metadata = { ...(binding ?? {}), ...presentedMetadata(threadId, presentation) };
  return {
    createdAt: new Date(createdAt),
    id: threadId,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(damage === undefined ? {} : { readFailure: damage }),
    resourceId,
    title: presentation.title ?? DEFAULT_THREAD_TITLE,
    updatedAt: new Date(updatedAt),
  };
}

/** A thread Core has just started: its creation is its only committed fact. */
function projectStarted(
  threadId: string,
  resourceId: string,
  rows: readonly HostLogRow[]
): AssistantMemoryThread {
  const started = rows.find((row) => row.event.type === 'thread.started');
  if (started?.ts === undefined) {
    throw new Error('Host thread has no committed creation timestamp');
  }
  return projectThread(resourceId, {
    binding: null,
    createdAt: started.ts,
    threadId,
    updatedAt: started.ts,
  });
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
    readonly canvases: HostThreadCanvases;
    readonly catalogLoaded: boolean;
    /** BST-1932: a child thread's call sign and family colour; absent for a top-level thread. */
    readonly child: { readonly callSign: string; readonly color: string } | undefined;
    /** BST-2004: the frame's host connection, whose current client serves the thread. */
    readonly connection: DesktopHostConnection;
    readonly onRunningChange: ((threadId: string, running: boolean) => void) | undefined;
    readonly onTitleCommitted: () => void;
    readonly ledger: HostThreadLedger;
    /** The host's catalog lists this thread. */
    readonly owned: boolean;
    readonly providerReadErrors: Parameters<AssistantThreadHostCapability['renderThread']>[3];
    readonly runs: HostThreadRuns;
    readonly threadId: string;
  }) => ReturnType<AssistantThreadHostCapability['renderThread']>,
  connection: DesktopHostConnection = createDesktopHostConnection(connectDesktopAgentHost)
): AssistantThreadHostCapability & {
  readonly ledger: HostThreadLedger;
  readonly runs: HostThreadRuns;
} {
  const runs = new HostThreadRuns();
  const ledger = new HostThreadLedger();
  const canvases = new HostThreadCanvases();
  const titleListeners = new Set<() => void>();
  const titleCommitted = (): void => {
    for (const listener of titleListeners) {
      listener();
    }
  };
  let catalogLoaded = false;
  let seededBy: HostClient | undefined;
  // Host-owned thread IDs; every request goes to the connection's current client.
  const threads = new Set<string>();
  const childViews = new Map<string, { readonly callSign: string; readonly color: string }>();
  const client = (): Promise<HostClient> => connection.current();
  // The catalog and Core's ledger: two reads, whatever the threads' lengths.
  const listThreads = async (resourceId: string): Promise<readonly AssistantMemoryThread[]> => {
    const host = await client();
    const [catalog, costs] = await Promise.all([
      host.request('thread/list', {}),
      host.request('ledger/read', {}),
    ]);
    for (const { threadId } of catalog.threads) {
      threads.add(threadId);
    }
    seededBy = host;
    runs.seed(
      catalog.threads.flatMap(({ latestRun, threadId }) =>
        latestRun ? [[threadId, latestRun] as const] : []
      )
    );
    ledger.seed(costs.threads);
    catalogLoaded = true;
    return catalog.threads.map((entry) => projectThread(resourceId, entry));
  };
  const threadClient = async (threadId: string): Promise<HostClient | undefined> => {
    if (threads.has(threadId)) {
      return await client();
    }
    if (!catalogLoaded) {
      await listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
      return threads.has(threadId) ? await client() : undefined;
    }
    // Absence from this window's snapshot is not historical ownership: another
    // client (a window or the CLI) may have created the thread since. Only the
    // host's current catalog decides; a failed read rejects, never defaults.
    const host = await client();
    const catalog = await host.request('thread/list', {});
    if (!catalog.threads.some((thread) => thread.threadId === threadId)) {
      return;
    }
    threads.add(threadId);
    return host;
  };
  // BST-2004: a replaced host's catalog re-seeds the run and cost views; each
  // thread view rebinds itself to the new client.
  connection.subscribe(() => {
    const state = connection.getSnapshot();
    if (state.kind !== 'connected' || !catalogLoaded || state.client === seededBy) {
      return;
    }
    seededBy = state.client;
    listThreads(WORKSPACE_MEMORY_RESOURCE_ID).catch((error: unknown) => {
      logger.error('The replaced agent host catalog could not be read', { error });
    });
  });
  return {
    // BST-1932: a listed child is driven through its parent's host client.
    childThreads: async (threadId) => {
      const host = await threadClient(threadId);
      if (!host) {
        throw new Error('This thread is not owned by the agent host');
      }
      return (await host.request('thread/children', { threadId })).children.map(
        ({ callSign, color, origin, status, threadId: child }) => {
          threads.add(child);
          childViews.set(child, { callSign, color });
          return {
            callSign,
            color,
            depth: origin.depth,
            parentRunId: origin.parentRunId,
            parentThreadId: origin.parentThreadId,
            persona: origin.persona,
            status,
            threadId: child,
            toolCallId: origin.toolCallId,
          };
        }
      );
    },
    createThread: async (resourceId) => {
      const host = await client();
      const { threadId } = await host.request('thread/start', { commandId: crypto.randomUUID() });
      const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
      threads.add(threadId);
      return projectStarted(threadId, resourceId, rows);
    },
    deleteThread: async (threadId) => {
      const host = await client();
      const catalog = await host.request('thread/list', {});
      if (!catalog.threads.some((thread) => thread.threadId === threadId)) {
        return;
      }
      // The host deletes the thread with every child thread under it, children first.
      const { threadIds } = await host.request('thread/delete', { threadId });
      for (const deleted of threadIds) {
        threads.delete(deleted);
        childViews.delete(deleted);
        runs.delete(deleted);
        ledger.delete(deleted);
      }
      return threadIds;
    },
    isHostThread: (threadId) => threads.has(threadId),
    ledger,
    listThreads,
    ownsThread: async (threadId) => (await threadClient(threadId)) !== undefined,
    // This frame's desktop-ui client: the host reads its own store; Main serves none.
    providers: {
      readOpenRouterModel: async (model) =>
        await (await client()).request('providers/openrouter-model', { model }),
      readStatus: async () => await (await client()).request('host/status', {}),
      verifyProvider: async (provider) =>
        await (await client()).request('providers/verify', { provider }),
    },
    readCanvases: async (threadId) => {
      const host = await threadClient(threadId);
      if (!host) {
        return;
      }
      return foldHostCanvases((await host.request('thread/read', { fromSeq: 0, threadId })).rows);
    },
    renameThread: async (threadId, title) => {
      const host = await threadClient(threadId);
      if (!host) {
        throw new Error('This thread is not owned by the agent host');
      }
      await host.request('thread/update', { commandId: crypto.randomUUID(), threadId, title });
    },
    renderThread: (threadId, _isVisible, onRunningChange, providerReadErrors) =>
      renderThread({
        canvases,
        catalogLoaded,
        child: childViews.get(threadId),
        connection,
        ledger,
        onRunningChange,
        onTitleCommitted: titleCommitted,
        owned: threads.has(threadId),
        providerReadErrors,
        runs,
        threadId,
      }),
    // The child's own committed origin authorizes a restored tab address; its
    // parent's listing presents it.
    resolveChildThread: async (threadId) => {
      const host = await client();
      const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
      const started = rows.find((row) => row.event.type === 'thread.started')?.event;
      if (!(started?.type === 'thread.started' && 'origin' in started)) {
        throw new Error('The child conversation is missing or does not belong to this workspace.');
      }
      const { children } = await host.request('thread/children', {
        threadId: started.origin.parentThreadId,
      });
      const child = children.find((candidate) => candidate.threadId === threadId);
      if (!child) {
        throw new Error('The child conversation is missing or does not belong to this workspace.');
      }
      threads.add(threadId);
      childViews.set(threadId, { callSign: child.callSign, color: child.color });
      return {
        callSign: child.callSign,
        color: child.color,
        depth: child.origin.depth,
        parentRunId: child.origin.parentRunId,
        parentThreadId: child.origin.parentThreadId,
        persona: child.origin.persona,
        status: child.status,
        threadId,
        toolCallId: child.origin.toolCallId,
      };
    },
    rewindPort: (threadId) => {
      if (!threads.has(threadId)) {
        return;
      }
      const changes = resolveChangesBridge();
      if (!changes) {
        throw new Error('Restoring a host thread needs the desktop changes bridge');
      }
      // Each rewind request goes to the current client, whichever host serves it.
      return createHostRewindPort(
        {
          request: async (method, params, signal) =>
            await (await client()).request(method, params, signal),
        },
        changes
      );
    },
    runs,
    // Gap 10: the host's own arms for the Threads panel's fused search. A matched
    // child is the host's too, so its result can open through this client.
    searchThreads: async (query, semantic) => {
      const host = await client();
      const { messages, similar, titles } = await host.request('thread/search', {
        query,
        ...(semantic
          ? {
              semantic: {
                profile: { ...semantic.profile },
                threshold: semantic.threshold,
                vector: [...semantic.vector],
              },
            }
          : {}),
      });
      for (const { threadId } of [...messages, ...similar, ...titles]) {
        threads.add(threadId);
      }
      const armMessage = ({
        createdAt,
        headline,
        messageId,
        role,
        threadId,
      }: (typeof messages)[number]) => ({
        headline,
        messageCreatedAt: new Date(createdAt),
        messageId,
        role,
        threadId,
      });
      return {
        messages: messages.map(armMessage),
        similarMessages: similar.map(armMessage),
        titles,
      };
    },
    // The semantic arm's backlog, embedded by this renderer's search embedder.
    searchVectors: {
      coverage: async (profile) =>
        await (await client()).request('thread/search/coverage', { profile: { ...profile } }),
      pending: async (profile, limit) =>
        (
          await (
            await client()
          ).request('thread/search/pending', {
            limit,
            profile: { ...profile },
          })
        ).rows,
      put: async (profile, rows) =>
        await (await client()).request('thread/search/vectors', {
          profile: { ...profile },
          rows: rows.map((row) =>
            'vector' in row ? { ...row, vector: [...row.vector] } : { ...row }
          ),
        }),
    },
    subscribeCanvases: canvases.subscribe,
    // BST-1932: the host says which thread's children changed; nothing is polled.
    subscribeChildren: (listener) => {
      let active = true;
      let followed: HostClient | undefined;
      let release: (() => void) | undefined;
      const follow = (): void => {
        const state = connection.getSnapshot();
        if (!active || state.kind !== 'connected' || state.client === followed) {
          return;
        }
        const replaced = followed !== undefined;
        release?.();
        followed = state.client;
        release = state.client.onChildrenChanged(listener);
        // BST-2004: children may have changed while no host client listened.
        if (replaced) {
          for (const threadId of threads) {
            listener(threadId);
          }
        }
      };
      const unfollow = connection.subscribe(follow);
      client().then(follow, (error: unknown) => {
        logger.error('Host child changes could not be followed', { error });
      });
      return () => {
        active = false;
        unfollow();
        release?.();
      };
    },
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
