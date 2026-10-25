import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  type HostMethod,
  type HostParams,
  type HostResults,
  parseHostParams,
  type WorkspaceIndexEvent,
} from '@brainstrike/agent-host/protocol';
import type { IndexConfigCapability } from '@brainstrike/assistant-contract/index-config';
import type {
  IndexChunkBoundsCapability,
  IndexLifecycleCapability,
  IndexRetryCapability,
  IndexRootRegistrationCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';
import { hostStream } from './host-stream';

/** The search index as the desktop's Search, Settings and chunk overlays read it. */
export type DesktopWorkspaceIndex = IndexConfigCapability &
  IndexSearchCapability &
  IndexChunkBoundsCapability &
  IndexRootRegistrationCapability &
  IndexRetryCapability &
  IndexLifecycleCapability;

type DesktopWorkspaceIndexMethod = Extract<HostMethod, `index/${string}`>;

let windowIndex: DesktopWorkspaceIndex | undefined;

/**
 * ADR-0029 stage 4: the native search index lives in the agent host. A window
 * without the agent-host capability (hidden hosts) has none of it.
 */
export function resolveDesktopWorkspaceIndex(): DesktopWorkspaceIndex | null {
  if (!window.agentHost) {
    return null;
  }
  windowIndex ??= createDesktopWorkspaceIndex(windowHostConnection());
  return windowIndex;
}

/** One index subscription for this window, on the frame's host connection. */
export function createDesktopWorkspaceIndex(
  connection: DesktopHostConnection
): DesktopWorkspaceIndex {
  let attached: HostClient | undefined;
  const client = async (): Promise<HostClient> => {
    const host = await connection.current();
    if (host !== attached) {
      attached = host;
      host.onWorkspaceIndex(events.dispatch);
    }
    return host;
  };
  // BST-2004: a replaced host reopens the stream this window follows.
  connection.subscribe(() => {
    const state = connection.getSnapshot();
    if (state.kind === 'connected' && attached !== undefined && state.client !== attached) {
      events.reopen();
    }
  });
  const events = hostStream<WorkspaceIndexEvent>('Search index', async () => {
    await (await client()).request('index/subscribe', {});
  });
  const request = async <M extends DesktopWorkspaceIndexMethod>(
    method: M,
    params: HostParams<M>
  ): Promise<HostResults[M]> => await (await client()).request(method, params);
  return {
    coverage: (scope) => request('index/coverage', scope),
    coverageBatch: (requests) => request('index/coverage-batch', { requests }),
    fileChunks: (files) => request('index/file-chunks', files),
    grep: (query) => request('index/grep', query),
    onConfigChanged: (listener) =>
      events.subscribe((event) => {
        if (event.type === 'config') {
          listener(event.config);
        }
      }),
    onLifecycleChanged: (listener) =>
      events.subscribe((event) => {
        if (event.type === 'lifecycle') {
          listener(event.observation);
        }
      }),
    readConfig: () => request('index/config/read', {}),
    rebuild: async () => {
      await request('index/rebuild', {});
    },
    retryIndexing: async () => {
      await request('index/retry', {});
    },
    rootsRegistered: async () => {
      await request('index/roots-registered', {});
    },
    search: (query) => request('index/search', query),
    status: () => request('index/status', {}),
    // Settings hands over an untyped change; it leaves only as the patch the host accepts.
    updateConfig: async (patch) =>
      await request('index/config/update', parseHostParams('index/config/update', patch)),
  };
}
