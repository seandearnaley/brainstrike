import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { loadWorkspaceRootsFromCatalog } from './assistant-server/workspace-roots';
import type { DesktopHookTrust } from './desktop-hook-trust';
import {
  type DbRootLite,
  getProjectHooksForReview,
  type ProjectHooksReview,
  resolveDbRootForPath,
} from './ipc-hooks-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/** Trust writes change what runs on the user's machine: the visible UI only. */
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

/**
 * Load the mounted catalog roots (id + path) so a reviewed/attested path can be
 * resolved to its canonical root id and containment-checked. The catalog is the
 * SAME source the assistant server resolves roots from, so the panel, the
 * attestation, and the server all key trust by one id.
 */
async function loadDbRoots(workspaceRoots: WorkspaceRootPort): Promise<DbRootLite[]> {
  const roots = await loadWorkspaceRootsFromCatalog(workspaceRoots);
  return roots.map((root) => ({ id: root.rootId, path: root.path }));
}

/** The mounted root containing `absPath`; trust names that root, never a renderer id. */
async function containingDbRoot(
  workspaceRoots: WorkspaceRootPort,
  absPath: string
): Promise<DbRootLite> {
  if (!isAbsolute(absPath.trim())) {
    throw new Error('root path must be a non-empty absolute path');
  }
  const dbRoot = resolveDbRootForPath(
    absPath.trim(),
    await loadDbRoots(workspaceRoots),
    realpathSync
  );
  if (!dbRoot) {
    throw new Error('root path is not within a mounted workspace root');
  }
  return dbRoot;
}

export function registerHooksIpcHandlers(
  hookTrust: DesktopHookTrust,
  workspaceRoots: WorkspaceRootPort
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.handle(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.getProjectHooksForReview,
    Schema.Tuple([Schema.String, Schema.String]),
    async (_event, rootId, absPath): Promise<ProjectHooksReview> => {
      const dbRoots = await loadDbRoots(workspaceRoots);
      const review = getProjectHooksForReview(rootId, absPath, {
        resolveDbRoot: (path) => resolveDbRootForPath(path, dbRoots, realpathSync),
      });
      const dbRoot = dbRoots.find((root) => root.id === review.dbRootId);
      if (!dbRoot) {
        return review;
      }
      // The host's trust for this root at this path: the status the panel shows.
      const approvedSha256 = await hookTrust.approval({ absPath: dbRoot.path, rootId: dbRoot.id });
      return approvedSha256 === undefined ? review : { ...review, approvedSha256 };
    }
  );

  registry.handle(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.trustProjectHooks,
    Schema.Tuple([Schema.String, Sha256Schema]),
    async (_event, absPath, sha256): Promise<void> => {
      const dbRoot = await containingDbRoot(workspaceRoots, absPath);
      await hookTrust.trust({ path: dbRoot.path, rootId: dbRoot.id, sha256 });
    }
  );

  registry.handle(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.untrustProjectHooks,
    Schema.Tuple([Schema.String]),
    async (_event, absPath): Promise<void> => {
      await hookTrust.untrust((await containingDbRoot(workspaceRoots, absPath)).id);
    }
  );

  return () => {
    registry.unregisterAll();
  };
}
