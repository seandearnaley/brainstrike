// The state DB schema at version 1: the run-log tables plus the 16 authoritative tables of the PostgreSQL inventory
// (m0/inventory.md class C-small), and the upgrader that applies it.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { migrate, SCHEMA_VERSION, UPGRADES } from '../src/schema.mjs';
import { STATE_DB, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

const C_SMALL = [
  'brainstrike_assistant_compaction_ranges',
  'brainstrike_assistant_edit_checkpoints',
  'brainstrike_assistant_message_tombstones',
  'brainstrike_assistant_run_errors',
  'brainstrike_assistant_run_events',
  'brainstrike_assistant_run_outcomes',
  'brainstrike_assistant_run_treatments',
  'brainstrike_assistant_run_usage',
  'brainstrike_assistant_task_lists',
  'brainstrike_diagnostic_events',
  'brainstrike_forge_prs',
  'brainstrike_mcp_task_authorities',
  'brainstrike_mcp_tasks',
  'brainstrike_mind_ops',
  'brainstrike_token_estimate_calibration',
  'brainstrike_workspace_snapshots',
  'brainstrike_worktrees',
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
      expect(tables).toEqual([...C_SMALL, ...RUN_LOG, ...MEMORY].sort());
    } finally {
      db.close();
    }
  });

  test('columns follow the PostgreSQL migrations (spot checks across the later ALTERs)', async () => {
    const { db } = await openDb();
    const cols = (t: string): string[] =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    try {
      // 089 and 091 appended three budget columns
      expect(cols('brainstrike_token_estimate_calibration').slice(-3)).toEqual([
        'resolved_domain_budget_tokens',
        'resolved_transport_budget_tokens',
        'prompt_baseline_tokens',
      ]);
      // 112 appended setup_reason
      expect(cols('brainstrike_worktrees').at(-1)).toBe('setup_reason');
      // 115 dropped generation and appended authority_epoch + blocked_diagnostic
      expect(cols('brainstrike_mcp_tasks')).not.toContain('generation');
      expect(cols('brainstrike_mcp_tasks').slice(-2)).toEqual([
        'authority_epoch',
        'blocked_diagnostic',
      ]);
    } finally {
      db.close();
    }
  });

  test('CHECK constraints carry over: booleans are 0/1, json columns hold valid JSON, enums are closed', async () => {
    const { db } = await openDb();
    try {
      const ins = db.prepare(
        "INSERT INTO brainstrike_assistant_run_treatments (run_id, thread_id, resource_id, injection_status, signal_injected) VALUES (?, 't', 'r', ?, ?)"
      );
      ins.run('ok', 'injected', 1);
      expect(() => ins.run('bool', 'injected', 2)).toThrow(/CHECK constraint failed/);
      expect(() => ins.run('consistency', 'no_waste', 1)).toThrow(/CHECK constraint failed/);
      expect(() => ins.run('enum', 'bogus', 0)).toThrow(/CHECK constraint failed/);
      const tasks = db.prepare(
        "INSERT INTO brainstrike_assistant_task_lists (thread_id, resource_id, tasks) VALUES (?, 'r', ?)"
      );
      tasks.run('a', '[]');
      expect(() => tasks.run('b', 'not json')).toThrow(/CHECK constraint failed/);
      expect(
        db
          .prepare("SELECT tasks FROM brainstrike_assistant_task_lists WHERE thread_id = 'a'")
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
