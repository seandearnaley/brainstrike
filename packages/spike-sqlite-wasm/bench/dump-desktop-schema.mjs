// BST-1940 spike: record the exact DDL the DESKTOP creates for a fresh profile, by running the real
// desktop StateStore (state.db) and the real IndexerPort process (state-index derived store) on
// better-sqlite3, then reading sqlite_schema in creation order. The browser replays this list
// unchanged, so "what breaks" is measured against what desktop actually builds.
// Usage: node bench/dump-desktop-schema.mjs <out.json>
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStateStoreIndexer, openIndexer } from '../../indexer/dist/index.js';
import { StateStore } from '../../state-store/dist/index.js';

const out = process.argv[2];
if (!out) {
  throw new Error('usage: dump-desktop-schema.mjs <out.json>');
}
const producer = new URL(
  '../../indexer/__tests__/fixtures/state-search-schema.mjs',
  import.meta.url
).href;
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bst1940-desktop-schema-')));
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 10_000, startupMs: 10_000 };
const indexPath = path.join(root, 'index.sqlite');
try {
  const port = await openIndexer(
    {
      dbPath: indexPath,
      embedding: { indexMode: 'text-only' },
      rootIds: ['canonical'],
      stateProjection: { mode: 'dev', module: producer },
      stateRoot: root,
    },
    deadlines
  );
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  await store.append([
    { event: { prompt: 'hello', runId: 'run-1', type: 'prompt', v: 1 }, threadId: 't1' },
    { event: { runId: 'run-1', text: 'world', type: 'answer', v: 1 }, threadId: 't1' },
  ]);
  await port.searchState({ limit: 5, query: 'hello', threadIds: ['t1'] });
  await store.close();
  await port.close();

  const dump = (file) => {
    const db = new Database(file, { readonly: true });
    try {
      const shadow = new Set(
        db.prepare("SELECT name FROM pragma_table_list WHERE type='shadow'").pluck().all()
      );
      const objects = db
        .prepare(
          "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
        )
        .all()
        .map((row) => ({ ...row, shadow: shadow.has(row.name) }));
      // FTS5 options set with INSERT INTO t(t,rank) (e.g. 'secure-delete') live in t_config, not sqlite_schema.
      const ftsConfig = objects
        .filter((row) => /USING fts5\(/i.test(row.sql))
        .flatMap((row) =>
          db
            .prepare(`SELECT k AS key, v AS value FROM "${row.name}_config" WHERE k <> 'version'`)
            .all()
            .map((config) => ({ table: row.name, ...config }))
        );
      return {
        ftsConfig,
        objects,
        pageSize: db.pragma('page_size', { simple: true }),
        sqliteVersion: db.prepare('SELECT sqlite_version()').pluck().get(),
        userVersion: db.pragma('user_version', { simple: true }),
      };
    } finally {
      db.close();
    }
  };
  const result = {
    generatedAt: new Date().toISOString(),
    index: dump(indexPath),
    note: 'Desktop DDL as created by StateStore.open + openIndexer (text-only, stateRoot set) on better-sqlite3.',
    state: dump(path.join(root, 'state.db')),
  };
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      index: result.index.objects.length,
      indexVersion: result.index.userVersion,
      native: result.state.sqliteVersion,
      state: result.state.objects.length,
      stateVersion: result.state.userVersion,
    })}\n`
  );
} finally {
  await rm(root, { force: true, recursive: true });
}
