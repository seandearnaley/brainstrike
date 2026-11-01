import { MODEL_CHOICE_SCHEMA } from './model-choice-domain.mjs';
import { THREAD_GROUPS_SCHEMA, THREAD_PINS_SCHEMA } from './thread-groups-domain.mjs';
import { seedViewFilterPresets, VIEW_FILTER_PRESET_SCHEMA } from './view-filter-preset-domain.mjs';
// @ts-check
// The state DB schema and its upgrader. `PRAGMA user_version` is the schema version; `UPGRADES[v - 1]` takes the DB from
// version v - 1 to v in one transaction, so a crash mid-upgrade leaves the previous version intact. Version 1 holds:
//   run_events    the run log (M0-A2 src/sqlite-log.ts + M0-A1 src/store-sqlite-worker.mjs): `id` is the global append
//                 order, (thread_id, seq) the per-thread order. Every payload carries a crc (src/run-log-format.mjs).
//   run_sync      one marker per thread, committed synchronous=FULL at each step boundary (M0-A1)
//   settings      app settings (M0-A2 src/host.ts STATE_DDL)
//   purge_intent  a purge in progress, replayed at open after a crash (M0-A2 src/host.ts)
// Version 6 adds `run_events.hydrate`: 0 keeps a row (a streamed text delta) out of the hydration read, which walks the
// partial index of the rows that keep it. The tables of versions 8 (the source catalog), 10 (embedding collections) and
// 13 are retired (BST-2436 deleted the workspace index): each step creates nothing, so a DB that reached it still opens.
// Version 14 adds `thread_pins`, the Threads panel's pinned threads. Version 1's `run_events.raw_count` (the deleted
// Coalescer's chunk count) is retired the same way: a DB that has the column keeps it unread and unwritten.
// Version 15 creates `roots`, the table the agent host's root registry writes, which pins each folder's grant-time
// identity. A DB whose `roots` already has that identity keeps it; one whose `roots` predates it drops those rows,
// since an identity never recorded cannot be inferred, and the person opens them again.

import { AUTHORITATIVE_SCHEMA } from './authoritative-schema.mjs';
import { MCP_TASK_THREAD_SCHEMA } from './mcp-task-domain.mjs';
import { MEMORY_SCHEMA } from './memory-domain.mjs';
import { WORKSPACE_ROOT_SCHEMA } from './workspace-root-schema.mjs';

export const SCHEMA_VERSION = 15;

const V1 = `
  CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    run_id TEXT,
    payload TEXT NOT NULL,
    crc INTEGER NOT NULL,
    created_at REAL NOT NULL,
    UNIQUE (thread_id, seq)
  );
  CREATE TABLE IF NOT EXISTS run_sync (thread_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, at REAL NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS purge_intent (
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    hashes TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
  );

`;

/** @type {readonly string[]} */
export const UPGRADES = [
  V1,
  AUTHORITATIVE_SCHEMA,
  MEMORY_SCHEMA,
  `
  ALTER TABLE purge_intent ADD COLUMN operation TEXT NOT NULL DEFAULT 'event'
    CHECK (operation IN ('event','thread'));
  ALTER TABLE purge_intent ADD COLUMN memory_resources TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(memory_resources) AND json_type(memory_resources) = 'array');
`,
  MCP_TASK_THREAD_SCHEMA,
  `
  ALTER TABLE run_events ADD COLUMN hydrate INTEGER NOT NULL DEFAULT 1 CHECK (hydrate IN (0, 1));
  CREATE INDEX run_events_hydrate ON run_events (thread_id, seq) WHERE hydrate = 1;
`,
  '',
  '',
  MODEL_CHOICE_SCHEMA,
  '',
  VIEW_FILTER_PRESET_SCHEMA,
  THREAD_GROUPS_SCHEMA,
  '',
  THREAD_PINS_SCHEMA,
  '',
];

/**
 * Bring the schema to SCHEMA_VERSION. A DB written by a newer build is refused, never downgraded.
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function migrate(db) {
  const current = /** @type {number} */ (db.pragma('user_version', { simple: true }));
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `state.db schema version ${current} is newer than this build supports (${SCHEMA_VERSION})`
    );
  }
  for (let next = current + 1; next <= SCHEMA_VERSION; next++) {
    const sql = UPGRADES[next - 1];
    if (sql === undefined) {
      throw new Error(`no schema upgrade to version ${next}`);
    }
    db.transaction(() => {
      db.exec(sql);
      if (next === 11) {
        seedViewFilterPresets(db);
      }
      if (
        next === 15 &&
        !db.prepare("SELECT 1 FROM pragma_table_info('roots') WHERE name = 'canonical_path'").get()
      ) {
        db.exec(`DROP TABLE IF EXISTS roots;${WORKSPACE_ROOT_SCHEMA}`);
      }
      db.pragma(`user_version = ${next}`);
    })();
  }
}
