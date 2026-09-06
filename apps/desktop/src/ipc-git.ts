import type { GitDiffParams, StructuredFileDiffParams } from '@brainstrike/types';
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

  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.status,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown) => handlers.status(rootId)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.diff,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: GitDiffParams) => handlers.diff(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.structuredFileDiff,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: StructuredFileDiffParams) =>
      handlers.structuredFileDiff(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.stage,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { path?: string } = {}) => handlers.stage(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.unstage,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { path?: string } = {}) => handlers.unstage(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.commit,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { description?: string; summary: string }) =>
      handlers.commit(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.commitFiles,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { commit: string }) => handlers.commitFiles(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.aheadBehind,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown) => handlers.aheadBehind(rootId)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.fetch,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { remote: string }) => handlers.fetch(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.history,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { limit: number; offset: number; ref?: string }) =>
      handlers.history(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.push,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { remote?: string }) => handlers.push(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.pull,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown) => handlers.pull(rootId)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.repository,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown) => handlers.repository(rootId)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.createBranch,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { branch: string; startPoint?: string }) =>
      handlers.createBranch(rootId, params)
  );
  registry.registerAuthorizedInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.switchBranch,
    { roles: ['visible-ui'] },
    (_event, rootId: unknown, params: { branch: string }) => handlers.switchBranch(rootId, params)
  );

  return () => {
    registry.unregisterAll();
  };
}
