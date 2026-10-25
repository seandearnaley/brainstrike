import type { HostClient } from '@brainstrike/agent-host/browser';
import type {
  GitWorkspaceEvent,
  HostMethod,
  HostParams,
  HostResults,
} from '@brainstrike/agent-host/protocol';
import {
  NO_WORKSPACE_GIT_SERVICES,
  type WorkspaceGitServices,
} from '@brainstrike/app-shell/workspace-git-services';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';
import { hostStream } from './host-stream';

/** The host methods behind the desktop's git panel, Changes, forge and worktrees. */
export type DesktopGitWorkspaceMethod = Extract<
  HostMethod,
  `changes/${string}` | `forge/${string}` | `git/${string}` | `worktrees/${string}`
>;

let windowServices: WorkspaceGitServices | undefined;

/**
 * ADR-0029 stage 2: the workspace git cluster lives in the agent host. A
 * window without the agent-host capability (hidden hosts) has none of it.
 */
export function resolveDesktopWorkspaceGitServices(): WorkspaceGitServices {
  if (!window.agentHost) {
    return NO_WORKSPACE_GIT_SERVICES;
  }
  windowServices ??= createDesktopWorkspaceGitServices(windowHostConnection());
  return windowServices;
}

/** One event subscription for this window, on the frame's host connection. */
export function createDesktopWorkspaceGitServices(
  connection: DesktopHostConnection
): WorkspaceGitServices {
  let attached: HostClient | undefined;
  const client = async (): Promise<HostClient> => {
    const host = await connection.current();
    if (host !== attached) {
      attached = host;
      host.onGitWorkspace(events.dispatch);
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
  const events = hostStream<GitWorkspaceEvent>('Workspace git', async () => {
    await (await client()).request('workspace/git/subscribe', {});
  });
  const request = async <M extends DesktopGitWorkspaceMethod>(
    method: M,
    params: HostParams<M>
  ): Promise<HostResults[M]> => await (await client()).request(method, params);
  return {
    changes: {
      fileDiff: (rootId, changeset, path) =>
        request('changes/file-diff', { changeset, path, rootId }),
      inventory: (options) => request('changes/inventory', { ...options }),
      onInvalidated: (listener) =>
        events.subscribe((event) => {
          if (event.type === 'changes-invalidated') {
            listener(event.event);
          }
        }),
      resolveView: (rootId, changeset) => request('changes/resolve-view', { changeset, rootId }),
    },
    forge: {
      cacheSnapshot: () => request('forge/cache-snapshot', {}),
      identity: (rootId) => request('forge/identity', { rootId }),
      onPrUpdated: (listener) =>
        events.subscribe((event) => {
          if (event.type === 'forge-pr-updated') {
            listener(event.event);
          }
        }),
      prStatus: (rootId) => request('forge/pr-status', { rootId }),
      refresh: (rootId, { reason }) => request('forge/refresh', { reason, rootId }),
    },
    git: {
      aheadBehind: (rootId) => request('git/ahead-behind', { rootId }),
      commit: (rootId, params) => request('git/commit', { ...params, rootId }),
      commitFiles: (rootId, { commit }) => request('git/commit-files', { commit, rootId }),
      createBranch: (rootId, params) => request('git/create-branch', { ...params, rootId }),
      diff: (rootId, diff) => request('git/diff', { diff, rootId }),
      fetch: (rootId, { remote }) => request('git/fetch', { remote, rootId }),
      history: (rootId, params) => request('git/history', { ...params, rootId }),
      pull: (rootId) => request('git/pull', { rootId }),
      push: (rootId, params) => request('git/push', { ...params, rootId }),
      repository: (rootId) => request('git/repository', { rootId }),
      stage: (rootId, params) => request('git/stage', { ...params, rootId }),
      status: (rootId) => request('git/status', { rootId }),
      structuredFileDiff: (rootId, diff) => request('git/structured-file-diff', { diff, rootId }),
      switchBranch: (rootId, { branch }) => request('git/switch-branch', { branch, rootId }),
      unstage: (rootId, params) => request('git/unstage', { ...params, rootId }),
    },
    worktrees: {
      adopt: (params) => request('worktrees/adopt', params),
      archive: (params) => request('worktrees/archive', params),
      checkoutStatus: ({ path }) => request('worktrees/checkout-status', { path }),
      create: (params) => request('worktrees/create', params),
      createBranchHere: (params) => request('worktrees/create-branch-here', params),
      createContext: ({ rootId }) => request('worktrees/create-context', { rootId }),
      getSettings: () => request('worktrees/settings/read', {}),
      inspectArchive: ({ worktreeId }) => request('worktrees/inspect-archive', { worktreeId }),
      list: () => request('worktrees/list', {}),
      listManagedPaths: () => request('worktrees/managed-paths', {}),
      restore: ({ worktreeId }) => request('worktrees/restore', { worktreeId }),
      setSettings: (params) => request('worktrees/settings/write', params),
    },
  };
}
