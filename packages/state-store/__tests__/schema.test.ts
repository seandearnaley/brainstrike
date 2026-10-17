// The current state DB owns run history, memory and the desktop content catalog.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { migrate, SCHEMA_VERSION, UPGRADES } from '../src/schema.mjs';
import { STATE_DB, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

const C_SMALL = [
  'brainstrike_forge_prs',
  'brainstrike_mcp_task_authorities',
  'brainstrike_mcp_tasks',
  'brainstrike_mind_ops',
  'brainstrike_worktrees',
];
const DESKTOP_CATALOG = [
  'embedding_sets',
  'file_records',
  'model_choices',
  'prompt_item_revisions',
  'prompt_items',
  'provider_choices',
  'roots',
  'source_blob_gc',
  'thread_groups',
  'thread_placements',
  'view_filter_presets',
];
const RUN_LOG = ['purge_intent', 'run_events', 'run_sync', 'settings', 'threads'];
const MEMORY = ['brainstrike_memory_scopes', 'brainstrike_memory_entities'];
const ISO = '2026-10-02T00:00:00.000Z';

async function openDb(): Promise<{ store: StateStore; db: Database.Database }> {
  const root = freshDir('schema');
  const store = await StateStore.open(root);
  await store.close();
  const db = new Database(join(root, STATE_DB));
  db.pragma('foreign_keys = ON');
  return { db, store };
}

describe('state DB migrations', () => {
  test('holds the run log, native memory, thread, usage and recovered C-small tables', async () => {
    const { db } = await openDb();
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .pluck()
        .all() as string[];
      expect(tables).toEqual([...C_SMALL, ...RUN_LOG, ...MEMORY, ...DESKTOP_CATALOG].sort());
    } finally {
      db.close();
    }
  });

  test('columns follow the PostgreSQL migrations (spot checks across the later ALTERs)', async () => {
    const { db } = await openDb();
    const cols = (t: string): string[] =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    try {
      // 112 appended setup_reason
      expect(cols('brainstrike_worktrees').at(-1)).toBe('setup_reason');
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

  test('CHECK constraints carry over: booleans are 0/1, json columns hold valid JSON, enums are closed', async () => {
    const { db } = await openDb();
    try {
      const pr = db.prepare(
        "INSERT INTO brainstrike_forge_prs (repo_common_dir, branch, number, url, title, state, is_draft, checks_json, head_sha, observed_at) VALUES ('/repo', ?, 1, 'u', 't', ?, ?, ?, 'sha', ?)"
      );
      pr.run('ok', 'open', 1, '[]', ISO);
      expect(() => pr.run('bool', 'open', 2, '[]', ISO)).toThrow(/CHECK constraint failed/);
      expect(() => pr.run('enum', 'bogus', 0, '[]', ISO)).toThrow(/CHECK constraint failed/);
      expect(() => pr.run('json', 'open', 0, 'not json', ISO)).toThrow(/CHECK constraint failed/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO brainstrike_forge_prs (repo_common_dir, branch, number, observed_at) VALUES ('/repo', 'partial', 1, ?)"
          )
          .run(ISO)
      ).toThrow(/CHECK constraint failed/);
      expect(
        db
          .prepare("SELECT checks_json FROM brainstrike_forge_prs WHERE branch = 'ok'")
          .pluck()
          .get()
      ).toBe('[]');
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
        /FOREIGN KEY constraint failed/
      );
      db.prepare("DELETE FROM brainstrike_mcp_task_authorities WHERE authority_epoch = 'e1'").run();
      expect(db.prepare('SELECT count(*) FROM brainstrike_mcp_tasks').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  test('mind_ops seq is never reused after the newest row is deleted (BIGSERIAL semantics)', async () => {
    const { db } = await openDb();
    try {
      const ins = db.prepare(
        "INSERT INTO brainstrike_mind_ops (entity_kind, entity_id, op) VALUES ('thread', ?, 'delete')"
      );
      const a = Number(ins.run('a').lastInsertRowid);
      db.prepare('DELETE FROM brainstrike_mind_ops WHERE seq = ?').run(a);
      const b = Number(ins.run('b').lastInsertRowid);
      expect(b).toBeGreaterThan(a);
    } finally {
      db.close();
    }
  });

  test('version 1 scaffold upgrades without losing its run log or settings', () => {
    const db = new Database(':memory:');
    try {
      db.exec(UPGRADES[0] as string);
      db.exec(
        "INSERT INTO settings VALUES ('existing','preserved'); INSERT INTO run_events VALUES (1,'t',1,'text',NULL,'payload',0,NULL,1); PRAGMA user_version=1;"
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

  test('the upgrader is idempotent and refuses a DB written by a newer build', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
      expect(() => migrate(db)).toThrow(/newer than this build supports/);
    } finally {
      db.close();
    }
  });
});
