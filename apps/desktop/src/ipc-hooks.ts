import { realpathSync } from 'node:fs';
import { ipcMain } from 'electron';
import {
  loadWorkspaceRootsFromDatabase,
  type WorkspaceRootsQueryable,
} from './assistant-server/workspace-roots';
import { getDatabase } from './db-main';
import {
  type DbRootLite,
  getProjectHooksForReview,
  resolveDbRootForPath,
  resolveTrustedRootIds,
} from './ipc-hooks-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Load the mounted DB `roots` (id + path) so a reviewed/attested path can be
 * resolved to its canonical DB root id and containment-checked. The DB is the
 * SAME source the assistant server resolves roots from, so the panel, the
 * attestation, and the server all key trust by one id.
 */
async function loadDbRoots(getDb: () => Promise<WorkspaceRootsQueryable>): Promise<DbRootLite[]> {
  const roots = await loadWorkspaceRootsFromDatabase(await getDb());
  return roots.map((root) => ({ id: root.rootId, path: root.path }));
}

export function registerHooksIpcHandlers(
  getDb: () => Promise<WorkspaceRootsQueryable> = getDatabase
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.getProjectHooksForReview,
    async (_event, rootId: unknown, absPath: unknown) => {
      const dbRoots = await loadDbRoots(getDb);
      return getProjectHooksForReview(rootId, absPath, {
        resolveDbRoot: (path) => resolveDbRootForPath(path, dbRoots, realpathSync),
      });
    }
  );

  registry.registerInvoke(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.resolveTrustedRootIds,
    async (_event, absPaths: unknown) => {
      const dbRoots = await loadDbRoots(getDb);
      return resolveTrustedRootIds(absPaths, (path) =>
        resolveDbRootForPath(path, dbRoots, realpathSync)
      );
    }
  );

  return () => {
    registry.unregisterAll();
  };
}
