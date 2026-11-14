// @ts-check
import { PROJECT_NAME_MAX_LENGTH } from './project-schema.mjs';

// The root domain runs in the desktop writer worker.
const columns = `id, path, canonical_path AS canonicalPath, display_name AS displayName, kind,
  status, created_at AS createdAt, last_verified_at AS lastVerifiedAt`;

/**
 * A project request the domain declines for a reason the person can act on (ADR-0034): a name
 * too long, or a folder or project it does not have. Nothing was written. The store hands its
 * code and message on as `StateStoreRefusalError`, and the host as a typed refusal.
 */
export class WorkspaceRootRefusal extends Error {
  /**
   * @param {string} code A boundary failure code, `project.<reason>`.
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceRootRefusal';
    /** @readonly */
    this.code = code;
  }
}

/**
 * The columns of a root record. A folder's project, and that project's name, are the ones recorded
 * for its canonical path; a root recorded as a managed worktree has none, being a checkout of its
 * repository.
 *
 * A state DB that opened damaged is served read-only as it stands and never upgraded, so one from
 * before version 16 has no project tables, and one from before version 18 no project names. The
 * table and the column are probed, and such a DB's folders read with no project or no name.
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
function rootProjection(db) {
  if (!hasTable(db, 'project_folders')) {
    return `${columns}, NULL AS projectId, NULL AS projectName`;
  }
  const name = hasColumn(db, 'projects', 'name')
    ? `CASE WHEN kind = 'path' THEN (SELECT project.name FROM project_folders AS folder
        JOIN projects AS project ON project.id = folder.project_id
        WHERE folder.canonical_path = roots.canonical_path) END`
    : 'NULL';
  return `${columns}, CASE WHEN kind = 'path' THEN (SELECT folder.project_id
        FROM project_folders AS folder WHERE folder.canonical_path = roots.canonical_path)
        END AS projectId, ${name} AS projectName`;
}

/**
 * Whether `table` has `column`, probed as a table is, for a damaged DB from before the column.
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} column
 * @returns {boolean}
 */
function hasColumn(db, table, column) {
  return Boolean(
    db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column)
  );
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
 * the commit that records the folder, or the commit that first names a repository found inside
 * an open folder (`rename-project` by path, BST-2520). A listing never makes one.
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

/**
 * `record` in the project `projectId`, with that project's name. Only a write calls it, so the
 * state DB is current and has the column.
 * @param {import('better-sqlite3').Database} db
 * @param {Omit<import('./workspace-root-types.ts').WorkspaceRootRecord, 'projectId' | 'projectName'>} record
 * @param {string | null} projectId
 * @returns {import('./workspace-root-types.ts').WorkspaceRootRecord}
 */
function inProject(db, record, projectId) {
  const name =
    projectId === null
      ? null
      : /** @type {string | null | undefined} */ (
          db.prepare('SELECT name FROM projects WHERE id = ?').pluck().get(projectId)
        );
  return { ...record, projectId, projectName: name ?? null };
}

/**
 * A managed worktree's or a scratch folder's record goes with its thread, including a folder
 * opened before it was adopted as a managed worktree (still kind `path`). Re-pinned to another
 * folder, it would part from the checkout the worktree ledger names at its path (ADR-0034
 * relink), so that is refused. The same folder at another path is not a move.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./workspace-root-types.ts').WorkspaceRootRecord} pinned
 * @param {string} canonicalPath The folder the record would be pinned to.
 */
function refuseMovingThreadFolder(db, pinned, canonicalPath) {
  if (pinned.canonicalPath === canonicalPath) {
    return;
  }
  const managed =
    pinned.kind !== 'path' ||
    db
      .prepare('SELECT 1 FROM brainstrike_worktrees WHERE path = ? AND archived_at IS NULL')
      .get(pinned.path);
  if (managed) {
    throw new WorkspaceRootRefusal(
      'workspace.locate-unknown',
      'Only one of your folders can be located; a worktree or a scratch folder goes with its thread.'
    );
  }
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
            inProject(
              db,
              {
                ...existing,
                canonicalPath: root.canonicalPath,
                lastVerifiedAt: now,
                status: /** @type {const} */ ('live'),
              },
              recordedFolderProject(db, existing, root.canonicalPath, now)
            ),
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
          refuseMovingThreadFolder(db, pinned, root.canonicalPath);
          db.prepare(`UPDATE roots SET path = ?, display_name = ?, canonical_path = ?,
            status = 'live', last_verified_at = ?, open_position = ${openPosition}
            WHERE id = ?`).run(root.path, root.displayName, root.canonicalPath, now, pinned.id);
          return {
            roots: [
              inProject(
                db,
                {
                  ...pinned,
                  canonicalPath: root.canonicalPath,
                  displayName: root.displayName,
                  lastVerifiedAt: now,
                  path: root.path,
                  status: /** @type {const} */ ('live'),
                },
                recordedFolderProject(db, pinned, root.canonicalPath, now)
              ),
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
          inProject(
            db,
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
            managed ? null : folderProject(db, root.canonicalPath, now)
          ),
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
            projectName: null,
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
 * The roots of every folder in `projectId`, oldest first.
 * @param {import('better-sqlite3').Database} db
 * @param {string} projection
 * @param {string} projectId
 * @returns {import('./workspace-root-types.ts').WorkspaceRootRecord[]}
 */
function projectRoots(db, projection, projectId) {
  return /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
    db
      .prepare(
        `SELECT ${projection} FROM roots WHERE kind = 'path' AND canonical_path IN
          (SELECT canonical_path FROM project_folders WHERE project_id = ?)
        ORDER BY created_at, rowid`
      )
      .all(projectId)
  );
}

/**
 * Names the project `projectId` (ADR-0034 build decisions). The name is trimmed and an empty one
 * clears it; one longer than `PROJECT_NAME_MAX_LENGTH` characters is refused, and so is a project
 * the store does not have. Answers the roots of the project's folders, with the name.
 * @param {import('better-sqlite3').Database} db
 * @param {string} projection
 * @param {{ readonly name: string; readonly projectId: string }} request
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply}
 */
function renameProject(db, projection, { name, projectId }) {
  const trimmed = projectName(name);
  return db.transaction(() => {
    const renamed = db
      .prepare('UPDATE projects SET name = ? WHERE id = ?')
      .run(trimmed === '' ? null : trimmed, projectId);
    if (renamed.changes === 0) {
      throw unknownProject();
    }
    return { roots: projectRoots(db, projection, projectId) };
  })();
}

/**
 * A project name as the person gave it, trimmed; an empty one clears it. One longer than
 * `PROJECT_NAME_MAX_LENGTH` characters is refused before anything is written.
 * @param {string} name
 * @returns {string}
 */
function projectName(name) {
  const trimmed = name.trim();
  if ([...trimmed].length > PROJECT_NAME_MAX_LENGTH) {
    throw new WorkspaceRootRefusal(
      'project.name-too-long',
      `A project name is at most ${PROJECT_NAME_MAX_LENGTH} characters, so the name was not changed.`
    );
  }
  return trimmed;
}

/** @returns {WorkspaceRootRefusal} */
function unknownProject() {
  return new WorkspaceRootRefusal(
    'project.unknown',
    'There is no project with this id, so nothing changed.'
  );
}

/** @returns {WorkspaceRootRefusal} */
function threadFolderRefusal() {
  return new WorkspaceRootRefusal(
    'project.thread-folder',
    'A managed worktree or a scratch folder has no project of its own to move: it lists with the thread that works in it.'
  );
}

/**
 * Whether `candidate` is `folder` or inside it, by path segments, in either separator.
 * @param {string} folder
 * @param {string} candidate
 * @returns {boolean}
 */
function isWithin(folder, candidate) {
  if (candidate === folder) {
    return true;
  }
  const prefixes = /[\\/]$/u.test(folder) ? [folder] : [`${folder}/`, `${folder}\\`];
  return prefixes.some((prefix) => candidate.startsWith(prefix));
}

/**
 * Refuses a repository's checkout path the person would name or move into a project (ADR-0034
 * build decisions, BST-2520), changing nothing: an empty or relative path; one inside a `.git`
 * folder, which is never a checkout (git names a submodule's main worktree
 * `<repository>/.git/modules/<path>`); and one inside a thread's own folder, a managed worktree
 * the ledger lists or a folder recorded as a managed worktree or a scratch folder, none of which
 * has a project of its own.
 * @param {import('better-sqlite3').Database} db
 * @param {string} canonicalPath
 * @param {RootPaths} paths
 */
function refuseRepositoryPath(db, canonicalPath, paths) {
  // A repository's checkout is named as a granted root is: by an absolute path.
  if (
    !(canonicalPath.trim() && paths.isGranted({ path: canonicalPath, preferredId: 'repository' }))
  ) {
    throw new Error("A repository's project requires its checkout's absolute canonical path");
  }
  if (canonicalPath.split(/[\\/]/u).includes('.git')) {
    throw new WorkspaceRootRefusal(
      'project.not-a-checkout',
      "This folder is inside a repository's .git folder, not a checkout, so it has no project of its own."
    );
  }
  const managed = 'SELECT path FROM brainstrike_worktrees WHERE archived_at IS NULL';
  const threadFolders = /** @type {string[]} */ (
    db
      .prepare(
        `${managed} UNION SELECT canonical_path FROM roots
          WHERE kind <> 'path' OR path IN (${managed})`
      )
      .pluck()
      .all()
  );
  if (threadFolders.some((folder) => isWithin(folder, canonicalPath))) {
    throw threadFolderRefusal();
  }
}

/**
 * The projects kept for `canonicalPaths` (ADR-0034 build decisions, BST-2520): a read for the
 * host's worktree listing, which never makes a project. A state DB that opened damaged from
 * before projects, or before their names, answers none, or none named.
 * @param {import('better-sqlite3').Database} db
 * @param {readonly string[]} canonicalPaths
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply}
 */
function repositoryProjects(db, canonicalPaths) {
  if (canonicalPaths.length === 0 || !hasTable(db, 'project_folders')) {
    return { projects: [], roots: [] };
  }
  const name = hasColumn(db, 'projects', 'name') ? 'project.name' : 'NULL';
  return {
    projects: /** @type {import('./workspace-root-types.ts').WorkspaceRepositoryProject[]} */ (
      db
        .prepare(
          `SELECT folder.canonical_path AS canonicalPath, project.id AS id, ${name} AS name
          FROM project_folders AS folder JOIN projects AS project ON project.id = folder.project_id
          WHERE folder.canonical_path IN (SELECT value FROM json_each(?))
          ORDER BY folder.canonical_path`
        )
        .all(JSON.stringify(canonicalPaths))
    ),
    roots: [],
  };
}

/**
 * Moves the folder at `canonicalPath` from the project `leftProjectId` into `projectId`, and
 * deletes the project it left once no folder is in it. Nothing else is written: a folder's trust
 * and its approved hooks stay keyed by its own path. Answers the projects it deleted, so the host
 * retires what it keeps for them (ADR-0040: a project's memory).
 * @param {import('better-sqlite3').Database} db
 * @param {string} canonicalPath
 * @param {string | null} leftProjectId
 * @param {string} projectId
 * @returns {string[]}
 */
function moveFolderToProject(db, canonicalPath, leftProjectId, projectId) {
  db.prepare(`INSERT INTO project_folders (canonical_path, project_id) VALUES (?, ?)
    ON CONFLICT (canonical_path) DO UPDATE SET project_id = excluded.project_id`).run(
    canonicalPath,
    projectId
  );
  if (leftProjectId !== null && leftProjectId !== projectId) {
    const deleted = db
      .prepare(`DELETE FROM projects WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM project_folders WHERE project_id = ?)`)
      .run(leftProjectId, leftProjectId);
    return deleted.changes > 0 ? [leftProjectId] : [];
  }
  return [];
}

/**
 * Names the project of a repository found inside an open folder, by its own checkout's canonical
 * path (ADR-0034 build decisions, BST-2520). Its first name makes the project, as `register` makes
 * an opened folder's, in the same commit; nothing else does, so a listing never writes one. An
 * empty name with no project yet writes nothing. No root is written, and nothing about trust or
 * hooks is. Refused, changing nothing, for a name too long and a path `refuseRepositoryPath`
 * refuses. Answers the roots of the project's folders, if any.
 * @param {import('better-sqlite3').Database} db
 * @param {string} projection
 * @param {{ readonly canonicalPath: string; readonly name: string }} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply}
 */
function renameRepositoryProject(db, projection, { canonicalPath, name }, paths) {
  const trimmed = projectName(name);
  return db.transaction(() => {
    refuseRepositoryPath(db, canonicalPath, paths);
    const recorded = db
      .prepare('SELECT 1 FROM project_folders WHERE canonical_path = ?')
      .get(canonicalPath);
    if (!recorded && trimmed === '') {
      return { roots: [] };
    }
    const projectId = folderProject(db, canonicalPath, Date.now());
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(
      trimmed === '' ? null : trimmed,
      projectId
    );
    return { roots: projectRoots(db, projection, projectId) };
  })();
}

/**
 * Joins a repository found inside an open folder, by its own checkout's canonical path, to the
 * project `projectId`, by the rules a folder's join follows (ADR-0034 build decisions, BST-2511,
 * BST-2520). With no project of its own yet, its folder row is made in the chosen project, in
 * the same commit. Refused for a path `refuseRepositoryPath` refuses and for a project the store
 * does not have. Answers the roots recorded at that path, if any.
 * @param {import('better-sqlite3').Database} db
 * @param {string} projection
 * @param {{ readonly canonicalPath: string; readonly projectId: string }} request
 * @param {RootPaths} paths
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply}
 */
function joinRepositoryProject(db, projection, { canonicalPath, projectId }, paths) {
  return db.transaction(() => {
    refuseRepositoryPath(db, canonicalPath, paths);
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      throw unknownProject();
    }
    const left = /** @type {string | undefined} */ (
      db
        .prepare('SELECT project_id FROM project_folders WHERE canonical_path = ?')
        .pluck()
        .get(canonicalPath)
    );
    const deletedProjectIds = moveFolderToProject(db, canonicalPath, left ?? null, projectId);
    return {
      deletedProjectIds,
      roots: /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
        db
          .prepare(`SELECT ${projection} FROM roots WHERE canonical_path = ? AND kind = 'path'`)
          .all(canonicalPath)
      ),
    };
  })();
}

/**
 * Joins the folder of the root `rootId` to the project `projectId`, as the person asked
 * (ADR-0034 build decisions): its folder row names that project, and the project it leaves is
 * deleted in the same commit once no folder is in it. Nothing else is written: a folder's trust
 * and its approved hooks stay keyed by its own path, so it keeps its own answers and takes none
 * of the project's. Refused for a root the store does not have, for a managed worktree or a
 * scratch folder, neither of which has a project of its own, and for a project the store does
 * not have. Answers the folder's root.
 * @param {import('better-sqlite3').Database} db
 * @param {string} projection
 * @param {{ readonly projectId: string; readonly rootId: string }} request
 * @returns {import('./workspace-root-types.ts').WorkspaceRootReply}
 */
function joinProject(db, projection, { projectId, rootId }) {
  return db.transaction(() => {
    const select = db.prepare(`SELECT ${projection} FROM roots WHERE id = ?`);
    const root =
      /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord | undefined} */ (
        select.get(rootId)
      );
    if (!root) {
      throw new WorkspaceRootRefusal(
        'project.folder-unknown',
        'There is no folder with this id, so nothing changed.'
      );
    }
    const managed = db
      .prepare('SELECT 1 FROM brainstrike_worktrees WHERE path = ? AND archived_at IS NULL')
      .get(root.path);
    if (root.kind !== 'path' || managed) {
      throw threadFolderRefusal();
    }
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      throw unknownProject();
    }
    const deletedProjectIds = moveFolderToProject(
      db,
      root.canonicalPath,
      root.projectId,
      projectId
    );
    return {
      deletedProjectIds,
      roots: /** @type {import('./workspace-root-types.ts').WorkspaceRootRecord[]} */ (
        select.all(rootId)
      ),
    };
  })();
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
        throw new WorkspaceRootRefusal(
          'project.folder-unknown',
          'There is no folder with this id, so nothing became a project.'
        );
      }
      if (scratch.kind !== 'scratch') {
        throw new WorkspaceRootRefusal(
          'project.not-scratch',
          'This folder is not a scratch folder, so it did not become a project.'
        );
      }
      const taken = db
        .prepare('SELECT 1 FROM roots WHERE id <> ? AND (path = ? OR canonical_path = ?)')
        .get(rootId, root.path, root.canonicalPath);
      if (taken) {
        throw new WorkspaceRootRefusal(
          'project.folder-recorded',
          'Another folder is already recorded at this place, so nothing became a project.'
        );
      }
      const now = Date.now();
      db.prepare(`UPDATE roots SET kind = 'path', path = ?, canonical_path = ?, display_name = ?,
        status = 'live', last_verified_at = ?,
        open_position = (SELECT COALESCE(MAX(open_position) + 1, 0) FROM roots)
        WHERE id = ?`).run(root.path, root.canonicalPath, root.displayName, now, rootId);
      db.prepare('DELETE FROM scratch_folders WHERE path = ?').run(scratch.path);
      return {
        roots: [
          inProject(
            db,
            {
              ...scratch,
              canonicalPath: root.canonicalPath,
              displayName: root.displayName,
              kind: /** @type {const} */ ('path'),
              lastVerifiedAt: now,
              path: root.path,
              status: /** @type {const} */ ('live'),
            },
            folderProject(db, root.canonicalPath, now)
          ),
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
  if (request.operation === 'repository-projects') {
    return repositoryProjects(db, request.canonicalPaths);
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
    case 'rename-project':
      return 'canonicalPath' in request
        ? renameRepositoryProject(db, projection, request, paths)
        : renameProject(db, projection, request);
    case 'join-project':
      return 'canonicalPath' in request
        ? joinRepositoryProject(db, projection, request, paths)
        : joinProject(db, projection, request);
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
