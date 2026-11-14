// The current state DB owns run history and the desktop content catalog.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { migrate, SCHEMA_VERSION, UPGRADES } from '../src/schema.mjs';
import { STATE_DB, StateStore } from '../src/state-store.js';
import { executeWorkspaceRootRequest } from '../src/workspace-root-domain.mjs';
import { WORKSPACE_ROOT_SCHEMA } from '../src/workspace-root-schema.mjs';
import { executeWorktreeLedgerRequest } from '../src/worktree-ledger-domain.mjs';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

const C_SMALL = [
  'brainstrike_mcp_task_authorities',
  'brainstrike_mcp_tasks',
  'brainstrike_worktrees',
];
const DESKTOP_CATALOG = [
  'model_choices',
  'project_folders',
  'projects',
  'provider_choices',
  'roots',
  'scratch_folders',
  'thread_groups',
  'thread_pins',
  'thread_placements',
  'view_filter_presets',
];
const RUN_LOG = ['purge_intent', 'run_events', 'run_sync', 'settings', 'threads'];
const ISO = '2026-10-02T00:00:00.000Z';
/** A managed worktree as the ledger records one, without the commit it was made at. */
const WORKTREE = {
  archivedAt: null,
  archiveSnapshotRef: null,
  baseRef: 'HEAD',
  branch: 'bs/new',
  createdAt: ISO,
  createdBy: 'agent',
  id: 'wt-new',
  path: '/wt/new',
  repoCommonDir: '/repo/.git',
  runId: null,
  setupOutput: null,
  setupReason: null,
  setupStatus: 'none',
  threadId: null,
} as const;
/** The roots table as version 16 left it, before a root could be a scratch folder. */
const V16_ROOTS = `CREATE TABLE roots (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) > 0),
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('path', 'worktree')),
  status TEXT NOT NULL CHECK (status IN ('live', 'disconnected')),
  open_position INTEGER CHECK (open_position IS NULL OR open_position >= 0),
  created_at REAL NOT NULL,
  last_verified_at REAL NOT NULL
) STRICT;`;
/** Every table as version 18 left it, before a worktree recorded the commit it was made at. */
const V18 = [...UPGRADES.slice(0, 16), V16_ROOTS, UPGRADES[16], UPGRADES[17]].join(';');

async function openDb(): Promise<{ store: StateStore; db: Database.Database }> {
  const root = freshDir('schema');
  const store = await StateStore.open(root);
  await store.close();
  const db = new Database(join(root, STATE_DB));
  db.pragma('foreign_keys = ON');
  return { db, store };
}

describe('state DB migrations', () => {
  test('holds the run log, thread, usage and recovered C-small tables', async () => {
    const { db } = await openDb();
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .pluck()
        .all() as string[];
      expect(tables).toEqual([...C_SMALL, ...RUN_LOG, ...DESKTOP_CATALOG].sort());
    } finally {
      db.close();
    }
  });

  test('columns follow the PostgreSQL migrations (spot checks across the later ALTERs)', async () => {
    const { db } = await openDb();
    const cols = (t: string): string[] =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    try {
      // 112 appended setup_reason; state DB version 19 base_commit
      expect(cols('brainstrike_worktrees').slice(-2)).toEqual(['setup_reason', 'base_commit']);
      // 115 dropped generation and appended authority_epoch + blocked_diagnostic; v5 thread_id
      expect(cols('brainstrike_mcp_tasks')).not.toContain('generation');
      expect(cols('brainstrike_mcp_tasks').slice(-3)).toEqual([
        'authority_epoch',
        'blocked_diagnostic',
        'thread_id',
      ]);
    } finally {
      db.close();
    }
  });

  test('CHECK constraints carry over: enums are closed and archive columns stay paired', async () => {
    const { db } = await openDb();
    try {
      const worktree = db.prepare(
        "INSERT INTO brainstrike_worktrees (id, repo_common_dir, path, base_ref, created_by, setup_status, archived_at, archive_snapshot_ref) VALUES (?, '/repo', ?, 'main', ?, ?, ?, ?)"
      );
      worktree.run('ok', '/wt/ok', 'agent', 'none', ISO, 'snapshot');
      expect(() => worktree.run('creator', '/wt/creator', 'bot', 'none', null, null)).toThrow(
        /CHECK constraint failed/u
      );
      expect(() => worktree.run('setup', '/wt/setup', 'user', 'bogus', null, null)).toThrow(
        /CHECK constraint failed/u
      );
      expect(() => worktree.run('archive', '/wt/archive', 'user', 'none', ISO, null)).toThrow(
        /CHECK constraint failed/u
      );
      expect(db.prepare('SELECT id FROM brainstrike_worktrees').pluck().all()).toEqual(['ok']);
    } finally {
      db.close();
    }
  });

  test('the surviving foreign key cascades (mcp task authority -> tasks), as in PostgreSQL', async () => {
    const { db } = await openDb();
    try {
      db.prepare(
        "INSERT INTO brainstrike_mcp_task_authorities (authority_epoch, server_id, resource, principal_id, runtime_id, connection_generation, created_at, updated_at) VALUES ('e1', 's', 'r', 'p', 'rt', 0, ?, ?)"
      ).run(ISO, ISO);
      const task = db.prepare(
        "INSERT INTO brainstrike_mcp_tasks (server_id, resource, principal_id, task_id, status, history, created_at, updated_at, authority_epoch) VALUES ('s', 'r', 'p', ?, 'working', '[{}]', ?, ?, ?)"
      );
      task.run('t1', ISO, ISO, 'e1');
      expect(() => task.run('t2', ISO, ISO, 'missing-epoch')).toThrow(
        /FOREIGN KEY constraint failed/u
      );
      db.prepare("DELETE FROM brainstrike_mcp_task_authorities WHERE authority_epoch = 'e1'").run();
      expect(db.prepare('SELECT count(*) FROM brainstrike_mcp_tasks').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  test('version 1 scaffold upgrades without losing its run log or settings', () => {
    const db = new Database(':memory:');
    try {
      db.exec(UPGRADES[0] as string);
      db.exec(
        "INSERT INTO settings VALUES ('existing','preserved'); INSERT INTO run_events VALUES (1,'t',1,'text',NULL,'payload',0,1); PRAGMA user_version=1;"
      );
      migrate(db);
      expect(db.prepare('SELECT value FROM settings').pluck().get()).toBe('preserved');
      expect(db.prepare('SELECT payload FROM run_events').pluck().get()).toBe('payload');
      expect(db.prepare('SELECT id FROM threads').pluck().all()).toEqual(['t']);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='brainstrike_mcp_tasks'")
          .pluck()
          .get()
      ).toBe('brainstrike_mcp_tasks');
    } finally {
      db.close();
    }
  });

  test('a profile whose folders predate their grant-time identity opens and forgets those folders', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(UPGRADES.slice(0, 14).join(';'));
      db.exec(`DROP TABLE IF EXISTS roots; CREATE TABLE roots (
        id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL, last_verified_at REAL NOT NULL
      ) STRICT;
      INSERT INTO roots VALUES ('r1', '/old', 'old', 'path', 'live', 1, 1);
      -- The retired source catalog (version 8) of a profile from before BST-2436.
      CREATE TABLE file_records (
        id TEXT PRIMARY KEY NOT NULL, root_id TEXT REFERENCES roots(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO file_records VALUES ('f1', 'r1');
      INSERT INTO settings VALUES ('existing', 'preserved');
      PRAGMA user_version = 14;`);
      migrate(db);
      expect(db.prepare('SELECT count(*) FROM roots').pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM file_records').pluck().get()).toBe(0);
      expect(db.prepare('SELECT value FROM settings').pluck().get()).toBe('preserved');
      db.prepare(
        "INSERT INTO roots (id, path, canonical_path, display_name, kind, status, open_position, created_at, last_verified_at) VALUES ('r2', '/new', '/new', 'new', 'path', 'live', 0, 1, 1)"
      ).run();
    } finally {
      db.close();
    }
  });

  test('a profile whose folders already carry their grant-time identity keeps them', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(UPGRADES.slice(0, 14).join(';'));
      db.exec(`DROP TABLE IF EXISTS roots;${WORKSPACE_ROOT_SCHEMA}
      INSERT INTO roots VALUES ('r1', '/cur', '/cur', 'cur', 'path', 'live', 0, 1, 1);
      PRAGMA user_version = 14;`);
      migrate(db);
      expect(db.prepare('SELECT canonical_path FROM roots').pluck().all()).toEqual(['/cur']);
    } finally {
      db.close();
    }
  });

  test('a profile from before projects keeps its folders, and each gets its project when it is next opened', () => {
    const db = new Database(':memory:');
    const paths = { isGranted: () => true };
    try {
      db.pragma('foreign_keys = ON');
      db.exec(UPGRADES.slice(0, 14).join(';'));
      db.exec(`DROP TABLE IF EXISTS roots;${WORKSPACE_ROOT_SCHEMA}
      INSERT INTO roots VALUES ('r1', '/cur', '/cur', 'cur', 'path', 'live', 0, 1, 1);
      PRAGMA user_version = 15;`);
      migrate(db);
      expect(executeWorkspaceRootRequest(db, { operation: 'list' }, paths).roots).toEqual([
        expect.objectContaining({ id: 'r1', projectId: null }),
      ]);
      const { roots } = executeWorkspaceRootRequest(
        db,
        {
          operation: 'register',
          root: { canonicalPath: '/cur', displayName: 'cur', path: '/cur', preferredId: 'r1' },
        },
        paths
      );
      expect(roots).toEqual([
        expect.objectContaining({ id: 'r1', projectId: expect.stringMatching(/\S/u) }),
      ]);
    } finally {
      db.close();
    }
  });

  test('a profile from before projects that opens damaged, so is not upgraded, still lists its folders', () => {
    const db = new Database(':memory:');
    const paths = { isGranted: () => true };
    try {
      db.exec(UPGRADES.slice(0, 14).join(';'));
      db.exec(`DROP TABLE IF EXISTS roots;${WORKSPACE_ROOT_SCHEMA}
      INSERT INTO roots VALUES ('r1', '/cur', '/cur', 'cur', 'path', 'live', 0, 1, 1);
      PRAGMA user_version = 15;`);
      // The writer serves a damaged state DB read-only as it stands and never upgrades it.
      db.pragma('query_only = ON');
      for (const operation of ['list', 'list-open'] as const) {
        expect(executeWorkspaceRootRequest(db, { operation }, paths).roots, operation).toEqual([
          expect.objectContaining({ id: 'r1', projectId: null, projectName: null }),
        ]);
      }
    } finally {
      db.close();
    }
  });

  test('a profile from before scratch folders keeps every folder, its order, kind and project', () => {
    const db = new Database(':memory:');
    const paths = { isGranted: () => true };
    try {
      db.pragma('foreign_keys = ON');
      db.exec(UPGRADES.slice(0, 16).join(';'));
      db.exec(`${V16_ROOTS}
      INSERT INTO roots VALUES ('r1', '/cur', '/cur', 'cur', 'path', 'live', 0, 1, 1);
      INSERT INTO roots VALUES ('r2', '/wt', '/wt', 'wt', 'worktree', 'disconnected', NULL, 2, 2);
      INSERT INTO projects VALUES ('p1', 1);
      INSERT INTO project_folders VALUES ('/cur', 'p1');
      PRAGMA user_version = 16;`);
      migrate(db);
      expect(executeWorkspaceRootRequest(db, { operation: 'list' }, paths).roots).toEqual([
        expect.objectContaining({ id: 'r1', kind: 'path', projectId: 'p1', status: 'live' }),
        expect.objectContaining({ id: 'r2', kind: 'worktree', projectId: null }),
      ]);
      expect(
        executeWorkspaceRootRequest(db, { operation: 'list-open' }, paths).roots.map(
          (root) => root.id
        )
      ).toEqual(['r1']);
      // The upgraded table takes a scratch folder (ADR-0034), recorded with its thread.
      expect(
        executeWorkspaceRootRequest(
          db,
          {
            operation: 'register-scratch',
            root: { canonicalPath: '/s/a', displayName: 'a', path: '/s/a', preferredId: 'r3' },
            threadId: 't1',
          },
          paths
        ).roots
      ).toEqual([expect.objectContaining({ id: 'r3', kind: 'scratch' })]);
    } finally {
      db.close();
    }
  });

  test('a profile from before scratch folders that opens damaged, so is not upgraded, has none', () => {
    const db = new Database(':memory:');
    const paths = { isGranted: () => true };
    try {
      db.exec(UPGRADES.slice(0, 16).join(';'));
      db.exec(`${V16_ROOTS}
      INSERT INTO roots VALUES ('r1', '/cur', '/cur', 'cur', 'path', 'live', 0, 1, 1);
      PRAGMA user_version = 16;`);
      db.pragma('query_only = ON');
      expect(
        executeWorkspaceRootRequest(db, { operation: 'scratch-of-thread', threadId: 't1' }, paths)
          .roots
      ).toEqual([]);
      expect(executeWorkspaceRootRequest(db, { operation: 'list-scratch' }, paths).roots).toEqual(
        []
      );
    } finally {
      db.close();
    }
  });

  test('a profile from before project names keeps its projects and folders, and its projects can be named', () => {
    const db = new Database(':memory:');
    const paths = { isGranted: () => true };
    try {
      db.pragma('foreign_keys = ON');
      db.exec(`${UPGRADES.slice(0, 16).join(';')};${V16_ROOTS}${UPGRADES[16]}`);
      db.exec(`INSERT INTO roots VALUES ('r1', '/cur', '/cur', 'cur', 'path', 'live', 0, 1, 1);
      INSERT INTO roots VALUES ('r2', '/two', '/two', 'two', 'path', 'disconnected', NULL, 2, 2);
      INSERT INTO projects VALUES ('p1', 1);
      INSERT INTO project_folders VALUES ('/cur', 'p1');
      INSERT INTO project_folders VALUES ('/two', 'p1');
      PRAGMA user_version = 17;`);
      migrate(db);
      expect(executeWorkspaceRootRequest(db, { operation: 'list' }, paths).roots).toEqual([
        expect.objectContaining({ id: 'r1', projectId: 'p1', projectName: null }),
        expect.objectContaining({ id: 'r2', projectId: 'p1', projectName: null }),
      ]);
      expect(
        executeWorkspaceRootRequest(
          db,
          { name: 'Named', operation: 'rename-project', projectId: 'p1' },
          paths
        ).roots
      ).toEqual([
        expect.objectContaining({ id: 'r1', projectName: 'Named' }),
        expect.objectContaining({ id: 'r2', projectName: 'Named' }),
      ]);
    } finally {
      db.close();
    }
  });

  test('a profile from before project names that opens damaged, so is not upgraded, reads its folders unnamed', () => {
    const db = new Database(':memory:');
    const paths = { isGranted: () => true };
    try {
      db.exec(`${UPGRADES.slice(0, 16).join(';')};${V16_ROOTS}${UPGRADES[16]}`);
      db.exec(`INSERT INTO roots VALUES ('r1', '/cur', '/cur', 'cur', 'path', 'live', 0, 1, 1);
      INSERT INTO projects VALUES ('p1', 1);
      INSERT INTO project_folders VALUES ('/cur', 'p1');
      PRAGMA user_version = 17;`);
      db.pragma('query_only = ON');
      for (const operation of ['list', 'list-open'] as const) {
        expect(executeWorkspaceRootRequest(db, { operation }, paths).roots, operation).toEqual([
          expect.objectContaining({ id: 'r1', projectId: 'p1', projectName: null }),
        ]);
      }
    } finally {
      db.close();
    }
  });

  test('a profile from before worktree base commits keeps its worktrees, read with none recorded', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`${V18};
      INSERT INTO brainstrike_worktrees (id, repo_common_dir, path, base_ref, created_by)
        VALUES ('wt-old', '/repo/.git', '/wt/old', 'HEAD', 'user');
      PRAGMA user_version = 18;`);
      migrate(db);
      expect(executeWorktreeLedgerRequest(db, { id: 'wt-old', operation: 'get' }).rows).toEqual([
        expect.objectContaining({ baseCommit: null, baseRef: 'HEAD', id: 'wt-old' }),
      ]);
      const recorded = { ...WORKTREE, baseCommit: 'b'.repeat(40) };
      expect(executeWorktreeLedgerRequest(db, { operation: 'insert', row: recorded }).rows).toEqual(
        [recorded]
      );
    } finally {
      db.close();
    }
  });

  test('a profile from before worktree base commits that opens damaged, so is not upgraded, reads its worktrees with none', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`${V18};
      INSERT INTO brainstrike_worktrees (id, repo_common_dir, path, base_ref, created_by)
        VALUES ('wt-old', '/repo/.git', '/wt/old', 'HEAD', 'user');
      PRAGMA user_version = 18;`);
      db.pragma('query_only = ON');
      for (const request of [
        { id: 'wt-old', operation: 'get' },
        { operation: 'list-active' },
        { operation: 'list-repository', repoCommonDir: '/repo/.git' },
      ] as const) {
        expect(executeWorktreeLedgerRequest(db, request).rows, request.operation).toEqual([
          expect.objectContaining({ baseCommit: null, id: 'wt-old' }),
        ]);
      }
    } finally {
      db.close();
    }
  });

  test('the upgrader is idempotent and refuses a DB written by a newer build', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
      expect(() => migrate(db)).toThrow(/newer than this build supports/u);
    } finally {
      db.close();
    }
  });
});
