// @ts-check

// The root domain runs in the desktop writer worker.
const projection = `id, path, canonical_path AS canonicalPath, display_name AS displayName, kind,
  status, created_at AS createdAt, last_verified_at AS lastVerifiedAt`;

/**
 * How the writer's host names a root it was granted: desktop main grants absolute OS paths.
 * @typedef {{ isGranted(root: { readonly path: string; readonly preferredId: string }): boolean }} RootPaths
 */

/** @param {import('better-sqlite3').Database} db
 * @param {import('./workspace-root-types.ts').WorkspaceRootRequest & {operation: 'register'}} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply} */
function register(db, request, paths) {
  const { root } = request;
  if (
    !(
      root.preferredId.trim() &&
      root.displayName.trim() &&
      root.canonicalPath.trim() &&
      paths.isGranted(root)
    )
  ) {
    throw new Error('Workspace registration requires the granted absolute path and identity');
  }
  return db.transaction(
    /** @returns {import('./workspace-root-types.ts').WorkspaceRootReply} */ () => {
      const existing =
        /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord | undefined} */ (
          db.prepare(`SELECT ${projection} FROM roots WHERE path = ?`).get(root.path)
        );
      const now = Date.now();
      // A registered folder is open: it keeps its place, or joins the end of the open folders.
      const nextPosition = '(SELECT COALESCE(MAX(open_position) + 1, 0) FROM roots)';
      if (existing) {
        // A folder at a recorded path that resolves elsewhere is another folder: only a fresh
        // grant by the person re-pins the record to it.
        if (existing.canonicalPath !== root.canonicalPath && !request.repin) {
          throw new Error('The workspace folder at this path is not the one that was granted');
        }
        db.prepare(`UPDATE roots SET status = 'live', last_verified_at = ?, canonical_path = ?,
          open_position = COALESCE(open_position, ${nextPosition}) WHERE id = ?`).run(
          now,
          root.canonicalPath,
          existing.id
        );
        return {
          roots: [
            {
              ...existing,
              canonicalPath: root.canonicalPath,
              lastVerifiedAt: now,
              status: /** @type {const} */ ('live'),
            },
          ],
        };
      }
      // A fresh grant of a recorded folder at a new path (its old alias is gone or now leads
      // elsewhere) keeps the folder's id and moves its record to the path the person chose.
      if (request.repin) {
        const pinned =
          /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord | undefined} */ (
            db.prepare(`SELECT ${projection} FROM roots WHERE id = ?`).get(root.preferredId)
          );
        if (pinned) {
          db.prepare(`UPDATE roots SET path = ?, display_name = ?, canonical_path = ?,
            status = 'live', last_verified_at = ?,
            open_position = COALESCE(open_position, ${nextPosition}) WHERE id = ?`).run(
            root.path,
            root.displayName,
            root.canonicalPath,
            now,
            pinned.id
          );
          return {
            roots: [
              {
                ...pinned,
                canonicalPath: root.canonicalPath,
                displayName: root.displayName,
                lastVerifiedAt: now,
                path: root.path,
                status: /** @type {const} */ ('live'),
              },
            ],
          };
        }
      }
      // The existing worktree ledger determines kind; callers cannot forge it.
      const managed = db
        .prepare('SELECT 1 FROM brainstrike_worktrees WHERE path = ? AND archived_at IS NULL')
        .get(root.path);
      const kind = managed ? 'worktree' : 'path';
      db.prepare(`INSERT INTO roots (id, path, canonical_path, display_name, kind, status,
        created_at, last_verified_at, open_position)
      VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ${nextPosition})`).run(
        root.preferredId,
        root.path,
        root.canonicalPath,
        root.displayName,
        kind,
        now,
        now
      );
      return {
        roots: [
          {
            canonicalPath: root.canonicalPath,
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
 * @param {import('./workspace-root-types.ts').WorkspaceRootRequest} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply} */
export function executeWorkspaceRootRequest(db, request, paths) {
  switch (request.operation) {
    case 'delete':
      return db.transaction(() => {
        const root =
          /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord | undefined} */ (
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
        roots: /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
          db.prepare(`SELECT ${projection} FROM roots ORDER BY created_at, rowid`).all()
        ),
      };
    case 'list-open':
      return {
        roots: /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
          db
            .prepare(
              `SELECT ${projection} FROM roots WHERE open_position IS NOT NULL ORDER BY open_position`
            )
            .all()
        ),
      };
    case 'disconnect-except':
      // Closing a folder and disconnecting what is not mounted commit together.
      return db.transaction(() => {
        const close = db.prepare('UPDATE roots SET open_position = NULL WHERE id = ?');
        for (const rootId of request.closeRootIds ?? []) {
          close.run(rootId);
        }
        return {
          roots: /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
            db
              .prepare(`UPDATE roots SET status = 'disconnected'
            WHERE status = 'live' AND path NOT IN (SELECT value FROM json_each(?))
            RETURNING ${projection}`)
              .all(JSON.stringify(request.mountedPaths))
          ),
        };
      })();
    default:
      throw new Error('Unknown workspace root operation');
  }
}
