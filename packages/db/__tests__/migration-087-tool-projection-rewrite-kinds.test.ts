import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_assistant_tool_projection_rewrites';

describe('migration 087: tool projection rewrite kinds (BST-1200)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-tool-rewrite-kinds'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 87));
  });

  afterEach(async () => db.close());

  it('backfills supersession rows and round-trips prune rows idempotently', async () => {
    await db.query(
      `INSERT INTO ${TABLE}
        (tool_call_id, thread_id, rewrite_id, superseded_by_tool_call_id, marker_text, original_chars)
       VALUES ('call-old', 'thread-1', 'rewrite-1', 'call-new', 'superseded marker', 42)`
    );
    const migration = migrations.find((candidate) => candidate.version === 87);
    expect(migration).toBeDefined();
    await db.exec(migration!.up);
    await db.exec(migration!.up);

    await db.query(
      `INSERT INTO ${TABLE}
        (tool_call_id, thread_id, rewrite_id, kind, superseded_by_tool_call_id, marker_text, original_chars)
       VALUES ('call-pruned', 'thread-1', 'rewrite-2', 'prune', NULL, 'pruned marker', 84)`
    );
    const rows = await db.query<{
      kind: string;
      supersededByToolCallId: string | null;
      toolCallId: string;
    }>(
      `SELECT tool_call_id AS "toolCallId", kind,
              superseded_by_tool_call_id AS "supersededByToolCallId"
       FROM ${TABLE} ORDER BY tool_call_id`
    );
    expect(rows.rows).toEqual([
      { kind: 'supersession', supersededByToolCallId: 'call-new', toolCallId: 'call-old' },
      { kind: 'prune', supersededByToolCallId: null, toolCallId: 'call-pruned' },
    ]);
  });

  it('down succeeds and drops prune rows after recency pruning has committed', async () => {
    // BST-1200 review PRRT_kwDOONNKB86XkWG4 / PRRT_kwDOONNKB86XkXvI: a naive
    // `SET NOT NULL` in `down` fails outright once any `kind = 'prune'` row
    // exists (they all carry NULL by this migration's own CHECK). Prune
    // overlays are a rebuildable transient — recency pruning re-derives them
    // deterministically from persisted history — so deleting them on
    // rollback is correct, and `down` must not error.
    const migration = migrations.find((candidate) => candidate.version === 87)!;
    await db.exec(migration.up);
    await db.query(
      `INSERT INTO ${TABLE}
        (tool_call_id, thread_id, rewrite_id, superseded_by_tool_call_id, marker_text, original_chars)
       VALUES ('call-old', 'thread-1', 'rewrite-1', 'call-new', 'superseded marker', 42)`
    );
    await db.query(
      `INSERT INTO ${TABLE}
        (tool_call_id, thread_id, rewrite_id, kind, superseded_by_tool_call_id, marker_text, original_chars)
       VALUES ('call-pruned', 'thread-1', 'rewrite-2', 'prune', NULL, 'pruned marker', 84)`
    );

    await db.exec(migration.down);

    const columns = await db.query<{ columnName: string }>(
      `SELECT column_name AS "columnName" FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'kind'`,
      [TABLE]
    );
    expect(columns.rows).toEqual([]);
    const rows = await db.query<{ supersededByToolCallId: string; toolCallId: string }>(
      `SELECT tool_call_id AS "toolCallId",
              superseded_by_tool_call_id AS "supersededByToolCallId"
       FROM ${TABLE} ORDER BY tool_call_id`
    );
    expect(rows.rows).toEqual([{ supersededByToolCallId: 'call-new', toolCallId: 'call-old' }]);
  });

  it('rejects rewrite-kind and superseder-nullability mismatches', async () => {
    const migration = migrations.find((candidate) => candidate.version === 87)!;
    await db.exec(migration.up);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (tool_call_id, thread_id, rewrite_id, kind, superseded_by_tool_call_id, marker_text, original_chars)
         VALUES ('bad-prune', 'thread-1', 'rewrite-1', 'prune', 'fake-call', 'marker', 1)`
      )
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (tool_call_id, thread_id, rewrite_id, kind, superseded_by_tool_call_id, marker_text, original_chars)
         VALUES ('bad-supersession', 'thread-1', 'rewrite-1', 'supersession', NULL, 'marker', 1)`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});
