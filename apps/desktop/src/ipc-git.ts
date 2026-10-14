import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { ipcMain } from 'electron';
import {
  createGitIpcHandlers,
  createWorkspaceRootResolver,
  type GitIpcHandlers,
} from './git-ipc-handlers';
import { gitContract } from './ipc-domains/git.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';

/**
 * Register the desktop `git` IPC domain.
 *
 * Each channel resolves + containment-checks the renderer-supplied `rootId`
 * against the DB-backed workspace roots, then runs `git` via `execFile` (no
 * shell) and returns a structured `GitResult`. See {@link createGitIpcHandlers}.
 *
 */
export function registerGitIpcHandlers(
  catalog: WorkspaceRootPort,
  handlers: GitIpcHandlers = createGitIpcHandlers({
    resolver: createWorkspaceRootResolver(catalog),
  })
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'git', gitContract, handlers);

  return () => {
    registry.unregisterAll();
  };
}
