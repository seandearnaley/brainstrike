import { ipcMain } from 'electron';
import { getDatabase } from './db-main';
import {
  createDatabaseRootResolver,
  createGitIpcHandlers,
  type GitIpcHandlers,
} from './git-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `git` IPC domain.
 *
 * Each channel resolves + containment-checks the renderer-supplied `rootId`
 * against the DB-backed workspace roots, then runs `git` via `execFile` (no
 * shell) and returns a structured `GitResult`. See {@link createGitIpcHandlers}.
 *
 */
export function registerGitIpcHandlers(
  handlers: GitIpcHandlers = createGitIpcHandlers({
    resolver: createDatabaseRootResolver(getDatabase),
  })
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.status, (_event, rootId: unknown) =>
    handlers.status(rootId)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.diff,
    (
      _event,
      rootId: unknown,
      params: { path?: string; staged?: boolean; untracked?: boolean } = {}
    ) => handlers.diff(rootId, params)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.stage,
    (_event, rootId: unknown, params: { path?: string } = {}) => handlers.stage(rootId, params)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.unstage,
    (_event, rootId: unknown, params: { path?: string } = {}) => handlers.unstage(rootId, params)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.commit,
    (_event, rootId: unknown, params: { description?: string; summary: string }) =>
      handlers.commit(rootId, params)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.commitDiff,
    (_event, rootId: unknown, params: { commit: string; originalPath?: string; path: string }) =>
      handlers.commitDiff(rootId, params)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.commitFiles,
    (_event, rootId: unknown, params: { commit: string }) => handlers.commitFiles(rootId, params)
  );
  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.aheadBehind, (_event, rootId: unknown) =>
    handlers.aheadBehind(rootId)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.fetch,
    (_event, rootId: unknown, params: { remote: string }) => handlers.fetch(rootId, params)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.history,
    (_event, rootId: unknown, params: { limit: number; offset: number; ref?: string }) =>
      handlers.history(rootId, params)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.push,
    (_event, rootId: unknown, params: { remote?: string }) => handlers.push(rootId, params)
  );
  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.pull, (_event, rootId: unknown) =>
    handlers.pull(rootId)
  );
  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.repository, (_event, rootId: unknown) =>
    handlers.repository(rootId)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.switchBranch,
    (_event, rootId: unknown, params: { branch: string }) => handlers.switchBranch(rootId, params)
  );

  return () => {
    registry.unregisterAll();
  };
}
