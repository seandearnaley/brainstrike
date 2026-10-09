import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ipcMain } from 'electron';
import { z } from 'zod';
import {
  loadWorkspaceRootsFromDatabase,
  type WorkspaceRootsQueryable,
} from './assistant-server/workspace-roots';
import { getDatabase } from './db-main';
import type { DesktopHookTrust } from './desktop-hook-trust';
import {
  type DbRootLite,
  getProjectHooksForReview,
  type ProjectHooksReview,
  resolveDbRootForPath,
} from './ipc-hooks-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;
/** Trust writes change what runs on the user's machine: the visible UI only. */
const VISIBLE_UI_POLICY = { roles: ['visible-ui'] } as const;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

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

/** The mounted root containing `absPath`; trust names that root, never a renderer id. */
async function containingDbRoot(
  getDb: () => Promise<WorkspaceRootsQueryable>,
  absPath: unknown
): Promise<DbRootLite> {
  if (typeof absPath !== 'string' || !isAbsolute(absPath.trim())) {
    throw new Error('root path must be a non-empty absolute path');
  }
  const dbRoot = resolveDbRootForPath(absPath.trim(), await loadDbRoots(getDb), realpathSync);
  if (!dbRoot) {
    throw new Error('root path is not within a mounted workspace root');
  }
  return dbRoot;
}

export function registerHooksIpcHandlers(
  hookTrust: DesktopHookTrust,
  getDb: () => Promise<WorkspaceRootsQueryable> = getDatabase
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.getProjectHooksForReview,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, rootId: unknown, absPath: unknown): Promise<ProjectHooksReview> => {
      const dbRoots = await loadDbRoots(getDb);
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

  registry.registerAuthorizedInvoke(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.trustProjectHooks,
    VISIBLE_UI_POLICY,
    async (_event, absPath: unknown, sha256: unknown): Promise<void> => {
      const dbRoot = await containingDbRoot(getDb, absPath);
      await hookTrust.trust({
        path: dbRoot.path,
        rootId: dbRoot.id,
        sha256: Sha256Schema.parse(sha256),
      });
    }
  );

  registry.registerAuthorizedInvoke(
    'hooks',
    DESKTOP_IPC_CHANNELS.hooks.untrustProjectHooks,
    VISIBLE_UI_POLICY,
    async (_event, absPath: unknown): Promise<void> => {
      await hookTrust.untrust((await containingDbRoot(getDb, absPath)).id);
    }
  );

  return () => {
    registry.unregisterAll();
  };
}
