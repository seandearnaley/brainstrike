// @ts-check
export { WORKSPACE_ROOT_SCHEMA } from './workspace-root-schema.mjs';

// The root domain runs wherever the state DB's schema does: the desktop writer worker and the browser writer.
const projection = `id, path, display_name AS displayName, kind, status,
  created_at AS createdAt, last_verified_at AS lastVerifiedAt`;

/**
 * How the writer's host names a root it was granted: desktop main grants absolute OS paths; the browser writer
 * keys a File System Access handle by its root (`@brainstrike/web-state-store`).
 * @typedef {{ isGrantedPath(path: string): boolean }} RootPaths
 */

/** @param {import('better-sqlite3').Database} db
 * @param {import('./workspace-root-types.js').WorkspaceRootRequest & {operation: 'register'}} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.js').WorkspaceRootReply} */
function register(db, request, paths) {
  const { root } = request;
  if (!(root.preferredId.trim() && root.displayName.trim() && paths.isGrantedPath(root.path))) {
    throw new Error('Workspace registration requires the granted absolute path and identity');
  }
  return db.transaction(
    /** @returns {import('./workspace-root-types.js').WorkspaceRootReply} */ () => {
      const existing =
        /** @type {import('./workspace-root-types.js').WorkspaceRootRecord | undefined} */ (
          db.prepare(`SELECT ${projection} FROM roots WHERE path = ?`).get(root.path)
        );
      const now = Date.now();
      if (existing) {
        db.prepare(`UPDATE roots SET status = 'live', last_verified_at = ? WHERE id = ?`).run(
          now,
          existing.id
        );
        return {
          roots: [{ ...existing, lastVerifiedAt: now, status: /** @type {const} */ ('live') }],
        };
      }
      // The existing worktree ledger determines kind; callers cannot forge it.
      const managed = db
        .prepare('SELECT 1 FROM brainstrike_worktrees WHERE path = ? AND archived_at IS NULL')
        .get(root.path);
      const kind = managed ? 'worktree' : 'path';
      db.prepare(`INSERT INTO roots (id, path, display_name, kind, status, created_at, last_verified_at)
      VALUES (?, ?, ?, ?, 'live', ?, ?)`).run(
        root.preferredId,
        root.path,
        root.displayName,
        kind,
        now,
        now
      );
      return {
        roots: [
          {
            createdAt: now,
            displayName: root.displayName,
            id: root.preferredId,
            kind,
            lastVerifiedAt: now,
            path: root.path,
            status: /** @type {const} */ ('live'),
          },
        ],
      };
    }
  )();
}

/** @param {import('better-sqlite3').Database} db
 * @param {import('./workspace-root-types.js').WorkspaceRootRequest} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.js').WorkspaceRootReply} */
export function executeWorkspaceRootRequest(db, request, paths) {
  switch (request.operation) {
    case 'delete':
      return db.transaction(() => {
        const root =
          /** @type {import('./workspace-root-types.js').WorkspaceRootRecord | undefined} */ (
            db.prepare(`SELECT ${projection} FROM roots WHERE id=?`).get(request.rootId)
          );
        if (!(root && request.paths.includes(root.path))) {
          throw new Error('Root deletion matched no captured path and identity');
        }
        db.prepare('DELETE FROM roots WHERE id=?').run(root.id);
        return { roots: [root] };
      })();
    case 'register':
      return register(db, request, paths);
    case 'list':
      return {
        roots: /** @type {import('./workspace-root-types.js').WorkspaceRootRecord[]} */ (
          db.prepare(`SELECT ${projection} FROM roots ORDER BY created_at, rowid`).all()
        ),
      };
    case 'disconnect-except':
      return {
        roots: /** @type {import('./workspace-root-types.js').WorkspaceRootRecord[]} */ (
          db
            .prepare(`UPDATE roots SET status = 'disconnected'
          WHERE status = 'live' AND path NOT IN (SELECT value FROM json_each(?))
          RETURNING ${projection}`)
            .all(JSON.stringify(request.mountedPaths))
        ),
      };
    default:
      throw new Error('Unknown workspace root operation');
  }
}
