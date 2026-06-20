import { ipcMain } from 'electron';
import type { WorkspaceRootsQueryable } from './assistant-server/workspace-roots';
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
 * `getDatabase` returns an untyped compatibility facade; it structurally
 * satisfies {@link WorkspaceRootsQueryable} (a `query<T>(sql, params)` method),
 * so we narrow it here rather than leaking `any` into the handler layer.
 */
export function registerGitIpcHandlers(
  handlers: GitIpcHandlers = createGitIpcHandlers({
    resolver: createDatabaseRootResolver(
      async () => (await getDatabase()) as WorkspaceRootsQueryable
    ),
  })
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.status, (_event, rootId: unknown) =>
    handlers.status(rootId)
  );
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.diff,
    (_event, rootId: unknown, params: { path?: string; staged?: boolean } = {}) =>
      handlers.diff(rootId, params)
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
    (_event, rootId: unknown, params: { message: string }) => handlers.commit(rootId, params)
  );
  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.aheadBehind, (_event, rootId: unknown) =>
    handlers.aheadBehind(rootId)
  );
  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.push, (_event, rootId: unknown) =>
    handlers.push(rootId)
  );
  registry.registerInvoke('git', DESKTOP_IPC_CHANNELS.git.pull, (_event, rootId: unknown) =>
    handlers.pull(rootId)
  );

  return () => {
    registry.unregisterAll();
  };
}
