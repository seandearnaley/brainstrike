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

/** The host methods behind the desktop's Changes, branch switcher and worktrees. */
export type DesktopGitWorkspaceMethod = Extract<
  HostMethod,
  `changes/${string}` | `git/${string}` | `worktrees/${string}`
>;

let windowServices: WorkspaceGitServices | undefined;

/**
 * ADR-0029 stage 2: the workspace git cluster lives in the agent host. A
 * window without the agent-host capability has none of it.
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
  // Each host numbers its events from 1, and a replacement host starts again.
  // Consumers drop a generation they have already seen, so this window
  // renumbers what it receives to stay monotonic across hosts.
  let generation = 0;
  const receive = (event: GitWorkspaceEvent): void => {
    generation += 1;
    events.dispatch({ event: { ...event.event, generation }, type: event.type });
  };
  const client = async (): Promise<HostClient> => {
    const host = await connection.current();
    if (host !== attached) {
      attached = host;
      host.onGitWorkspace(receive);
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
      apply: (params) => request('changes/apply', params),
      commits: (rootId, worktreePath) => request('changes/commits', { rootId, worktreePath }),
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
    git: {
      commit: (rootId, params) => request('git/commit', { ...params, rootId }),
      createBranch: (rootId, params) => request('git/create-branch', { ...params, rootId }),
      fetch: (rootId, { remote }) => request('git/fetch', { remote, rootId }),
      push: (rootId, params) => request('git/push', { ...params, rootId }),
      repository: (rootId) => request('git/repository', { rootId }),
      status: (rootId) => request('git/status', { rootId }),
      switchBranch: (rootId, { branch }) => request('git/switch-branch', { branch, rootId }),
    },
    worktrees: {
      adopt: (params) => request('worktrees/adopt', params),
      archive: (params) => request('worktrees/archive', params),
      checkoutStatus: ({ path }) => request('worktrees/checkout-status', { path }),
      create: (params) => request('worktrees/create', params),
      createBranchHere: (params) => request('worktrees/create-branch-here', params),
      createContext: ({ rootId }) => request('worktrees/create-context', { rootId }),
      decideSetupConsent: (params) => request('worktrees/setup-consent/decide', params),
      getSettings: () => request('worktrees/settings/read', {}),
      inspectArchive: ({ worktreeId }) => request('worktrees/inspect-archive', { worktreeId }),
      list: () => request('worktrees/list', {}),
      listArchived: ({ rootId }) => request('worktrees/list-archived', { rootId }),
      listManagedPaths: () => request('worktrees/managed-paths', {}),
      listSetupConsent: () => request('worktrees/setup-consent/list', {}),
      restore: ({ worktreeId }) => request('worktrees/restore', { worktreeId }),
      revokeSetupConsent: ({ repositoryId }) =>
        request('worktrees/setup-consent/revoke', { repositoryId }),
      setSettings: (params) => request('worktrees/settings/write', params),
    },
  };
}
