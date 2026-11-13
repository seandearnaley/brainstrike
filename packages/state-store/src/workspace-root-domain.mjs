// @ts-check

// The root domain runs in the desktop writer worker.
const columns = `id, path, canonical_path AS canonicalPath, display_name AS displayName, kind,
  status, created_at AS createdAt, last_verified_at AS lastVerifiedAt`;

/**
 * The columns of a root record. A folder's project is the one recorded for its canonical path; a
 * root recorded as a managed worktree has none, being a checkout of its repository.
 *
 * A state DB that opened damaged is served read-only as it stands and never upgraded, so one from
 * before version 16 has no project tables. The table is probed, and such a DB's folders read with
 * no project.
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
function rootProjection(db) {
  return hasTable(db, 'project_folders')
    ? `${columns}, CASE WHEN kind = 'path' THEN (SELECT folder.project_id
        FROM project_folders AS folder WHERE folder.canonical_path = roots.canonical_path)
        END AS projectId`
    : `${columns}, NULL AS projectId`;
}

/**
 * Whether the state DB has `table`. A damaged DB is served as it stands, so one from before the
 * table's version lacks it, and a read that needs it is probed rather than failed.
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @returns {boolean}
 */
function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
  );
}

/**
 * How the writer's host names a root it was granted: desktop main grants absolute OS paths.
 * @typedef {{ isGranted(root: { readonly path: string; readonly preferredId: string }): boolean }} RootPaths
 */

/**
 * The project of the folder at `canonicalPath`. A folder recorded for the first time starts a
 * project (ADR-0034, owner decisions 2026-11-10); this is the only place one is created, inside
 * the commit that records the folder.
 * @param {import('better-sqlite3').Database} db
 * @param {string} canonicalPath
 * @param {number} now
 * @returns {string}
 */
function folderProject(db, canonicalPath, now) {
  const recorded = /** @type {string | undefined} */ (
    db
      .prepare('SELECT project_id FROM project_folders WHERE canonical_path = ?')
      .pluck()
      .get(canonicalPath)
  );
  if (recorded !== undefined) {
    return recorded;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO projects (id, created_at) VALUES (?, ?)').run(id, now);
  db.prepare('INSERT INTO project_folders (canonical_path, project_id) VALUES (?, ?)').run(
    canonicalPath,
    id
  );
  return id;
}

/**
 * The project of a recorded folder registered again, which now resolves to `canonicalPath`. It
 * keeps its project. When the person picked it again at a new place, the project's folder moves
 * there with it, or the new place joins the project while another record still resolves to the
 * old one, so no record loses its project. When the new place already belongs to a project the
 * folder joins that one instead, and the place it left keeps the project it had.
 * @param {import('better-sqlite3').Database} db
 * @param {{ readonly canonicalPath: string; readonly id: string; readonly kind: 'path' | 'worktree' | 'scratch' }} recorded
 * @param {string} canonicalPath
 * @param {number} now
 * @returns {string | null}
 */
function recordedFolderProject(db, recorded, canonicalPath, now) {
  if (recorded.kind !== 'path') {
    return null;
  }
  if (recorded.canonicalPath !== canonicalPath) {
    const stillThere = db
      .prepare("SELECT 1 FROM roots WHERE canonical_path = ? AND id <> ? AND kind = 'path'")
      .get(recorded.canonicalPath, recorded.id);
    db.prepare(
      stillThere
        ? `INSERT OR IGNORE INTO project_folders (canonical_path, project_id)
            SELECT ?, project_id FROM project_folders WHERE canonical_path = ?`
        : 'UPDATE OR IGNORE project_folders SET canonical_path = ? WHERE canonical_path = ?'
    ).run(canonicalPath, recorded.canonicalPath);
  }
  return folderProject(db, canonicalPath, now);
}

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
  const projection = rootProjection(db);
  return db.transaction(
    /** @returns {import('./workspace-root-types.ts').WorkspaceRootReply} */ () => {
      const existing =
        /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord | undefined} */ (
          db.prepare(`SELECT ${projection} FROM roots WHERE path = ?`).get(root.path)
        );
      const now = Date.now();
      // A registered folder is open: it keeps its place, or joins the end of the open folders.
      // A managed worktree or a scratch folder never opens: each is a thread's own folder
      // (ADR-0034).
      const nextPosition = '(SELECT COALESCE(MAX(open_position) + 1, 0) FROM roots)';
      const openPosition = `CASE WHEN kind IN ('worktree', 'scratch') THEN NULL
            ELSE COALESCE(open_position, ${nextPosition}) END`;
      if (existing) {
        // A folder at a recorded path that resolves elsewhere is another folder: only a fresh
        // grant by the person re-pins the record to it.
        if (existing.canonicalPath !== root.canonicalPath && !request.repin) {
          throw new Error('The workspace folder at this path is not the one that was granted');
        }
        db.prepare(`UPDATE roots SET status = 'live', last_verified_at = ?, canonical_path = ?,
          open_position = ${openPosition} WHERE id = ?`).run(now, root.canonicalPath, existing.id);
        return {
          roots: [
            {
              ...existing,
              canonicalPath: root.canonicalPath,
              lastVerifiedAt: now,
              projectId: recordedFolderProject(db, existing, root.canonicalPath, now),
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
            status = 'live', last_verified_at = ?, open_position = ${openPosition}
            WHERE id = ?`).run(root.path, root.displayName, root.canonicalPath, now, pinned.id);
          return {
            roots: [
              {
                ...pinned,
                canonicalPath: root.canonicalPath,
                displayName: root.displayName,
                lastVerifiedAt: now,
                path: root.path,
                projectId: recordedFolderProject(db, pinned, root.canonicalPath, now),
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
      VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ${managed ? 'NULL' : nextPosition})`).run(
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
            projectId: managed ? null : folderProject(db, root.canonicalPath, now),
            status: /** @type {const} */ ('live'),
          },
        ],
      };
    }
  )();
}

/**
 * Records a folder the host just made as `threadId`'s scratch folder (ADR-0034), in one commit
 * with its root: the root is live, of kind `scratch`, never open and in no project. The kind
 * comes from this record, so no other registration can make a root one. A folder already
 * recorded, as a root or as a scratch folder, is not one the host made, and a thread has one.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./workspace-root-types.ts').WorkspaceRootRequest & {operation: 'register-scratch'}} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply}
 */
function registerScratch(db, request, paths) {
  const { root, threadId } = request;
  if (
    !(
      root.preferredId.trim() &&
      root.displayName.trim() &&
      root.canonicalPath.trim() &&
      threadId.trim() &&
      paths.isGranted(root)
    )
  ) {
    throw new Error('A scratch folder requires its absolute path, its identity and its thread');
  }
  return db.transaction(
    /** @returns {import('./workspace-root-types.ts').WorkspaceRootReply} */ () => {
      const recorded =
        db
          .prepare('SELECT 1 FROM roots WHERE path = ? OR canonical_path = ? OR id = ?')
          .get(root.path, root.canonicalPath, root.preferredId) ??
        db.prepare('SELECT 1 FROM scratch_folders WHERE path = ?').get(root.path);
      if (recorded) {
        throw new Error(
          'A scratch folder is a folder the host just made; this one is already recorded'
        );
      }
      if (db.prepare('SELECT 1 FROM scratch_folders WHERE thread_id = ?').get(threadId)) {
        throw new Error('This thread already has a scratch folder');
      }
      const now = Date.now();
      db.prepare('INSERT INTO scratch_folders (path, thread_id, created_at) VALUES (?, ?, ?)').run(
        root.path,
        threadId,
        now
      );
      db.prepare(`INSERT INTO roots (id, path, canonical_path, display_name, kind, status,
        created_at, last_verified_at, open_position)
      VALUES (?, ?, ?, ?, 'scratch', 'live', ?, ?, NULL)`).run(
        root.preferredId,
        root.path,
        root.canonicalPath,
        root.displayName,
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
            kind: /** @type {const} */ ('scratch'),
            lastVerifiedAt: now,
            path: root.path,
            projectId: null,
            status: /** @type {const} */ ('live'),
          },
        ],
      };
    }
  )();
}

/**
 * `threadId`'s scratch folder, as its root records it: none, or one. A state DB from before
 * version 17 that opened damaged has none.
 * @param {import('better-sqlite3').Database} db
 * @param {string} projection
 * @param {string} threadId
 * @returns {import('./workspace-root-types.ts').WorkspaceRootRecord[]}
 */
function scratchOfThread(db, projection, threadId) {
  if (!hasTable(db, 'scratch_folders')) {
    return [];
  }
  return /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
    db
      .prepare(
        `SELECT ${projection} FROM roots WHERE kind = 'scratch' AND path IN
          (SELECT path FROM scratch_folders WHERE thread_id = ?)`
      )
      .all(threadId)
  );
}

/**
 * Turns the scratch folder `rootId`, which the host has already moved to `root`, into a folder of
 * the person's (ADR-0034 build decisions), in one commit: the root keeps its id, its kind becomes
 * `path`, its place and name are the new ones, it joins the end of the open folders, its scratch
 * record is deleted, and it gets the project recorded for its new place, or a new one, as
 * `register` gives a folder its project. Refused, changing nothing, for a root the store does not
 * have, one that is not a scratch folder, and a place another record already has.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./workspace-root-types.ts').WorkspaceRootRequest & {operation: 'scratch-to-project'}} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply}
 */
function scratchToProject(db, request, paths) {
  const { root, rootId } = request;
  if (
    !(
      rootId.trim() &&
      root.displayName.trim() &&
      root.canonicalPath.trim() &&
      paths.isGranted({ path: root.path, preferredId: rootId })
    )
  ) {
    throw new Error('A scratch folder becomes a project at an absolute path, under its identity');
  }
  const projection = rootProjection(db);
  return db.transaction(
    /** @returns {import('./workspace-root-types.ts').WorkspaceRootReply} */ () => {
      const scratch =
        /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord | undefined} */ (
          db.prepare(`SELECT ${projection} FROM roots WHERE id = ?`).get(rootId)
        );
      if (!scratch) {
        throw new Error('There is no folder with this id, so nothing became a project.');
      }
      if (scratch.kind !== 'scratch') {
        throw new Error('This folder is not a scratch folder, so it did not become a project.');
      }
      const taken = db
        .prepare('SELECT 1 FROM roots WHERE id <> ? AND (path = ? OR canonical_path = ?)')
        .get(rootId, root.path, root.canonicalPath);
      if (taken) {
        throw new Error('Another folder is already recorded at this place.');
      }
      const now = Date.now();
      db.prepare(`UPDATE roots SET kind = 'path', path = ?, canonical_path = ?, display_name = ?,
        status = 'live', last_verified_at = ?,
        open_position = (SELECT COALESCE(MAX(open_position) + 1, 0) FROM roots)
        WHERE id = ?`).run(root.path, root.canonicalPath, root.displayName, now, rootId);
      db.prepare('DELETE FROM scratch_folders WHERE path = ?').run(scratch.path);
      return {
        roots: [
          {
            ...scratch,
            canonicalPath: root.canonicalPath,
            displayName: root.displayName,
            kind: /** @type {const} */ ('path'),
            lastVerifiedAt: now,
            path: root.path,
            projectId: folderProject(db, root.canonicalPath, now),
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
  if (request.operation === 'register') {
    return register(db, request, paths);
  }
  if (request.operation === 'register-scratch') {
    return registerScratch(db, request, paths);
  }
  if (request.operation === 'scratch-to-project') {
    return scratchToProject(db, request, paths);
  }
  const projection = rootProjection(db);
  switch (request.operation) {
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
              `SELECT ${projection} FROM roots WHERE open_position IS NOT NULL AND kind = 'path'
                ORDER BY open_position`
            )
            .all()
        ),
      };
    case 'list-worktrees':
      return {
        roots: /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
          db
            .prepare(
              `SELECT ${projection} FROM roots WHERE kind = 'worktree' AND path IN
                (SELECT path FROM brainstrike_worktrees WHERE archived_at IS NULL)
              ORDER BY created_at, rowid`
            )
            .all()
        ),
      };
    case 'list-scratch':
      return {
        roots: /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
          db
            .prepare(
              `SELECT ${projection} FROM roots WHERE kind = 'scratch' ORDER BY created_at, rowid`
            )
            .all()
        ),
      };
    case 'scratch-of-thread':
      return { roots: scratchOfThread(db, projection, request.threadId) };
    case 'forget-scratch':
      // The thread's root and its scratch record go together, in one commit.
      return db.transaction(() => {
        const forgotten = scratchOfThread(db, projection, request.threadId);
        const remove = db.prepare('DELETE FROM roots WHERE id = ?');
        for (const root of forgotten) {
          remove.run(root.id);
        }
        db.prepare('DELETE FROM scratch_folders WHERE thread_id = ?').run(request.threadId);
        return { roots: forgotten };
      })();
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
