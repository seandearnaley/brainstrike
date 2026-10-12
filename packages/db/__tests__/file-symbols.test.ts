import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyManagedCacheBatch } from '../src/managed-cache/apply-managed-cache-batch.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import {
  type FileSymbolInsert,
  type FileSymbolRefInsert,
  FileSymbolRepository,
} from '../src/repositories/file-symbol-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Symbol graph storage (BST-919 / BST-930).
 *
 * The design ruling under test everywhere here: refs store NAMES, not resolved
 * symbol ids. Symbol rows are deleted and re-inserted on every file edit (the
 * chunk lifecycle), so a stored cross-file `to_symbol_id` would dangle after
 * every re-index. A name join is stable under churn by construction, and
 * over-connecting is the correct failure direction for a retrieval index.
 * `from_symbol_id` (the enclosing definition) IS a real id, but it always
 * points into the same file's extraction batch — inserted in the same call —
 * so it cannot dangle across files. `docs/superpowers/plans/2026-07-26-symbol-graph.md`.
 */
describe('file symbol graph', () => {
  let db: PGlite;
  let repository: FileSymbolRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path) VALUES ('root-fixture', 'path', 'fixture', '/workspace/root')`
    );
    repository = new FileSymbolRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedFileRecord(id: string, path: string): Promise<void> {
    await db.query(
      `INSERT INTO file_records (id, name, path, size, root_id)
       VALUES ($1, $2, $3, 10, 'root-fixture')`,
      [id, path.split('/').at(-1) ?? path, path]
    );
  }

  function symbol(
    fileRecordId: string,
    n: number,
    name: string,
    overrides: Partial<FileSymbolInsert> = {}
  ): FileSymbolInsert {
    return {
      endLine: 20,
      endOffset: 400,
      exported: false,
      fileRecordId,
      kind: 'function',
      name,
      seq: n,
      startLine: 10,
      startOffset: 200,
      ...overrides,
    };
  }

  function ref(
    fileRecordId: string,
    n: number,
    name: string,
    overrides: Partial<FileSymbolRefInsert> = {}
  ): FileSymbolRefInsert {
    return {
      fileRecordId,
      kind: 'call',
      line: 12,
      name,
      seq: n,
      ...overrides,
    };
  }

  describe('migration 075 schema', () => {
    it('creates both tables with the expected columns', async () => {
      const symbols = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'file_symbols' ORDER BY column_name`
      );
      expect(symbols.rows.map((row) => row.column_name)).toEqual([
        'end_line',
        'end_offset',
        'exported',
        'file_record_id',
        'kind',
        'name',
        'seq',
        'start_line',
        'start_offset',
      ]);

      const refs = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'file_symbol_refs' ORDER BY column_name`
      );
      expect(refs.rows.map((row) => row.column_name)).toEqual([
        'file_record_id',
        'from_symbol_seq',
        'kind',
        'line',
        'module',
        'name',
        'seq',
      ]);
    });

    it('indexes the traversal join columns', async () => {
      // The name join IS the graph — without these indexes the recursive CTE
      // seq-scans per recursion level and the planner cost explodes on a large
      // workspace. The composite PKs double as
      // the per-file lookup index (deletion path), so file_record_id needs no
      // secondary index — a MEASURED decision (storage section of the
      // migration docstring).
      const result = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename IN ('file_symbols', 'file_symbol_refs')`
      );
      const defs = result.rows.map((row) => row.indexdef).join('\n');
      expect(defs).toContain('file_symbols USING btree (name)');
      expect(defs).toContain('file_symbol_refs USING btree (name, kind)');
      expect(defs).toContain('file_symbols USING btree (file_record_id, seq)');
      expect(defs).toContain('file_symbol_refs USING btree (file_record_id, seq)');
    });
  });

  describe('repository', () => {
    it('inserts symbols and refs in one call and reads them back', async () => {
      await seedFileRecord('file-a', 'src/a.ts');

      await repository.insertMany(
        [
          symbol('file-a', 0, 'startEmbeddingWorker', { exported: true }),
          symbol('file-a', 1, 'helper'),
        ],
        [
          ref('file-a', 0, 'acquireLease', { fromSymbolSeq: 0 }),
          ref('file-a', 1, 'node:worker_threads', {
            kind: 'import',
            module: 'node:worker_threads',
          }),
        ]
      );

      const symbols = await db.query<{ exported: boolean; name: string }>(
        `SELECT name, exported FROM file_symbols WHERE file_record_id = 'file-a' ORDER BY seq`
      );
      expect(symbols.rows).toEqual([
        { exported: true, name: 'startEmbeddingWorker' },
        { exported: false, name: 'helper' },
      ]);

      const refs = await db.query<{ from_symbol_seq: number | null; kind: string; name: string }>(
        `SELECT name, kind, from_symbol_seq FROM file_symbol_refs WHERE file_record_id = 'file-a' ORDER BY seq`
      );
      expect(refs.rows).toEqual([
        { from_symbol_seq: 0, kind: 'call', name: 'acquireLease' },
        { from_symbol_seq: null, kind: 'import', name: 'node:worker_threads' },
      ]);
    });

    it('inserts nothing when both arrays are empty', async () => {
      await expect(repository.insertMany([], [])).resolves.toBeUndefined();
    });

    it("REPLACES a file's previous rows on re-insert instead of colliding", async () => {
      // seq is deterministic (extraction order), so without replace semantics a
      // re-chunk of the same file — full-reindex recovery, a retry after a
      // crash — collides on the PK and the STALE graph keeps answering
      // traversals with only a warn as signal (#2032 review).
      await seedFileRecord('file-a', 'src/a.ts');
      await repository.insertMany(
        [symbol('file-a', 0, 'oldName')],
        [ref('file-a', 0, 'oldCallee', { fromSymbolSeq: 0 })]
      );

      await repository.insertMany(
        [symbol('file-a', 0, 'newName')],
        [ref('file-a', 0, 'newCallee', { fromSymbolSeq: 0 })]
      );

      const names = await db.query<{ name: string }>(
        `SELECT name FROM file_symbols WHERE file_record_id = 'file-a'`
      );
      expect(names.rows).toEqual([{ name: 'newName' }]);
      const refNames = await db.query<{ name: string }>(
        `SELECT name FROM file_symbol_refs WHERE file_record_id = 'file-a'`
      );
      expect(refNames.rows).toEqual([{ name: 'newCallee' }]);
    });

    it('rejects a ref whose enclosing symbol is not in the same batch', async () => {
      // The intra-batch invariant is what makes from_symbol_id safe under
      // churn. A dangling enclosing id must FAIL, not insert an orphan edge.
      await seedFileRecord('file-a', 'src/a.ts');
      await expect(
        repository.insertMany(
          [symbol('file-a', 0, 'fn')],
          [ref('file-a', 0, 'other', { fromSymbolSeq: 99 })]
        )
      ).rejects.toThrow();

      // And the failure is atomic: the symbol must not have landed either.
      const count = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM file_symbols WHERE file_record_id = 'file-a'`
      );
      expect(count.rows[0]?.n).toBe(0);
    });

    it('deleteForFileRecords removes symbols and refs for exactly those files', async () => {
      await seedFileRecord('file-a', 'src/a.ts');
      await seedFileRecord('file-b', 'src/b.ts');
      await repository.insertMany(
        [symbol('file-a', 0, 'fnA'), symbol('file-b', 0, 'fnB')],
        [ref('file-a', 0, 'x'), ref('file-b', 0, 'y')]
      );

      await repository.deleteForFileRecords(['file-a']);

      const symbols = await db.query<{ file_record_id: string }>(
        'SELECT file_record_id FROM file_symbols'
      );
      const refs = await db.query<{ file_record_id: string }>(
        'SELECT file_record_id FROM file_symbol_refs'
      );
      expect(symbols.rows).toEqual([{ file_record_id: 'file-b' }]);
      expect(refs.rows).toEqual([{ file_record_id: 'file-b' }]);
    });
  });

  describe('lifecycle', () => {
    it('deleting a file record cascades to its symbols and refs', async () => {
      await seedFileRecord('file-a', 'src/a.ts');
      await repository.insertMany(
        [symbol('file-a', 0, 'fn')],
        [ref('file-a', 0, 'x', { fromSymbolSeq: 0 })]
      );

      await db.query(`DELETE FROM file_records WHERE id = 'file-a'`);

      const remaining = await db.query<{ n: number }>(
        'SELECT (SELECT count(*) FROM file_symbols)::int + (SELECT count(*) FROM file_symbol_refs)::int AS n'
      );
      expect(remaining.rows[0]?.n).toBe(0);
    });

    it('a managed-cache REPLACE deletes stale symbols — the row survives, so CASCADE cannot do it', async () => {
      // The file_records row is UPDATEd on edit, not deleted; without the
      // explicit delete in applyManagedCacheReplacements, symbols from the
      // pre-edit parse would keep answering traversal queries forever.
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions) VALUES ('set-1', 'mk', 'mi', 3)`
      );
      await applyManagedCacheBatch(db, {
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export function oldName() {}',
              contentHash: 'hash-1',
              createdAt: now,
              id: 'file-a',
              name: 'a.ts',
              path: 'src/a.ts',
              processedAt: now,
              size: 10,
              tokenCount: 5,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      });
      await repository.insertMany([symbol('file-a', 0, 'oldName', { exported: true })], []);

      await applyManagedCacheBatch(db, {
        changes: [
          {
            mode: 'replace',
            record: {
              content: 'export function newName() {}',
              contentHash: 'hash-2',
              id: 'file-a',
              mtimeMs: 2,
              name: 'a.ts',
              path: 'src/a.ts',
              processedAt: now,
              size: 12,
              tokenCount: 6,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
      });

      const stale = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM file_symbols WHERE file_record_id = 'file-a'`
      );
      expect(stale.rows[0]?.n).toBe(0);
    });
  });

  describe('the headline traversal', () => {
    it('answers transitive callers via name join', async () => {
      // Seed graph: main -> calls run -> calls startEmbeddingWorker.
      // unrelated -> calls somethingElse.
      await seedFileRecord('file-worker', 'src/worker.ts');
      await seedFileRecord('file-run', 'src/run.ts');
      await seedFileRecord('file-main', 'src/main.ts');
      await seedFileRecord('file-unrelated', 'src/unrelated.ts');

      await repository.insertMany(
        [symbol('file-worker', 0, 'startEmbeddingWorker', { exported: true })],
        []
      );
      await repository.insertMany(
        [symbol('file-run', 0, 'run', { exported: true })],
        [ref('file-run', 0, 'startEmbeddingWorker', { fromSymbolSeq: 0 })]
      );
      await repository.insertMany(
        [symbol('file-main', 0, 'main')],
        [ref('file-main', 0, 'run', { fromSymbolSeq: 0 })]
      );
      await repository.insertMany(
        [symbol('file-unrelated', 0, 'other')],
        [ref('file-unrelated', 0, 'somethingElse', { fromSymbolSeq: 0 })]
      );

      // UNION (dedup) + join-terminated + explicit depth bound.
      const result = await db.query<{ depth: number; name: string; path: string }>(
        `WITH RECURSIVE callers(file_record_id, seq, name, depth) AS (
           SELECT s.file_record_id, s.seq, s.name, 0
           FROM file_symbols s WHERE s.name = 'startEmbeddingWorker'
           UNION
           SELECT encl.file_record_id, encl.seq, encl.name, c.depth + 1
           FROM callers c
           JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
           JOIN file_symbols encl
             ON encl.file_record_id = r.file_record_id AND encl.seq = r.from_symbol_seq
           WHERE c.depth < 10
         )
         SELECT fr.path, c.name, c.depth
         FROM callers c
         JOIN file_records fr ON fr.id = c.file_record_id
         ORDER BY c.depth, fr.path`
      );

      expect(result.rows).toEqual([
        { depth: 0, name: 'startEmbeddingWorker', path: 'src/worker.ts' },
        { depth: 1, name: 'run', path: 'src/run.ts' },
        { depth: 2, name: 'main', path: 'src/main.ts' },
      ]);
    });
  });
});

/**
 * The upgrade backfill (part of migration 075): files chunked BEFORE the
 * symbol tables existed would otherwise never re-chunk (unchanged size/mtime
 * is a stat-cache hit), leaving the graph permanently empty on existing
 * installs — the #2032 P1. Runs the numbered chain up to 074, seeds an
 * already-chunked record, then applies 075 and asserts the re-chunk marker.
 */
describe('migration 075 backfill', () => {
  it('resets chunks_processed_at for previously chunked files', { timeout: 120_000 }, async () => {
    const db = await wasmLoader.createPGlite('memory://migration-075-backfill');
    try {
      const runner = new MigrationRunner(db);
      await runner.initialize();
      for (const migration of migrations) {
        if (migration.version >= 75) {
          break;
        }
        await runner.runMigration(migration);
      }

      await db.query(
        `INSERT INTO roots (id, kind, display_name, path) VALUES ('r', 'path', 'r', '/')`
      );
      await db.query(
        `INSERT INTO file_records (id, name, path, size, root_id, content, chunks_processed_at, chunks_count, created_at, updated_at)
         VALUES ('file-old', 'a.ts', 'src/a.ts', 10, 'r', 'export const a = 1;', NOW()::text, 3, NOW()::text, NOW()::text)`
      );
      // A content-less record (never imported) must NOT be queued for chunking.
      await db.query(
        `INSERT INTO file_records (id, name, path, size, root_id, chunks_processed_at, created_at, updated_at)
         VALUES ('file-no-content', 'b.ts', 'src/b.ts', 10, 'r', NOW()::text, NOW()::text, NOW()::text)`
      );

      const migration075 = migrations.find((migration) => migration.version === 75);
      expect(migration075).toBeDefined();
      await runner.runMigration(migration075 as (typeof migrations)[number]);

      const marked = await db.query<{ marked: boolean; id: string }>(
        'SELECT id, (chunks_processed_at IS NULL) AS marked FROM file_records ORDER BY id'
      );
      // Only rows WITH stored content re-queue: a content-less record has
      // nothing to re-chunk from, and marking it would wedge the sync on a
      // no-op forever.
      expect(marked.rows).toEqual([
        { id: 'file-no-content', marked: false },
        { id: 'file-old', marked: true },
      ]);
    } finally {
      await db.close();
    }
  });
});
