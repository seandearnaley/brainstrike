import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyManagedCacheBatch } from '../src/managed-cache/apply-managed-cache-batch.js';
import {
  type FileSymbolInsert,
  type FileSymbolRefInsert,
  FileSymbolRepository,
} from '../src/repositories/file-symbol-repository.js';
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
      id: `${fileRecordId}_sym_${n}`,
      kind: 'function',
      name,
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
      id: `${fileRecordId}_ref_${n}`,
      kind: 'call',
      line: 12,
      name,
      ...overrides,
    };
  }

  describe('migration 075 schema', () => {
    it('creates both tables with the expected columns', async () => {
      const symbols = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'file_symbols' ORDER BY column_name`
      );
      expect(symbols.rows.map((row) => row.column_name)).toEqual([
        'created_at',
        'embedding_set_id',
        'end_line',
        'end_offset',
        'exported',
        'file_record_id',
        'id',
        'kind',
        'name',
        'start_line',
        'start_offset',
      ]);

      const refs = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'file_symbol_refs' ORDER BY column_name`
      );
      expect(refs.rows.map((row) => row.column_name)).toEqual([
        'created_at',
        'embedding_set_id',
        'file_record_id',
        'from_symbol_id',
        'id',
        'kind',
        'line',
        'module',
        'name',
      ]);
    });

    it('indexes the traversal join columns', async () => {
      // The name join IS the graph — without these indexes the recursive CTE
      // seq-scans per recursion level and the planner cost explodes past the
      // querySelf ceiling on a large workspace.
      const result = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename IN ('file_symbols', 'file_symbol_refs')`
      );
      const defs = result.rows.map((row) => row.indexdef).join('\n');
      expect(defs).toContain('file_symbols USING btree (name)');
      expect(defs).toContain('file_symbol_refs USING btree (name)');
      expect(defs).toContain('file_symbols USING btree (file_record_id)');
      expect(defs).toContain('file_symbol_refs USING btree (file_record_id)');
      expect(defs).toContain('file_symbol_refs USING btree (from_symbol_id)');
    });

    it('is readable by the querySelf sandbox role', async () => {
      // Migration 074's ALTER DEFAULT PRIVILEGES must cover these later tables;
      // this is the tripwire that contract promised.
      const result = await db.query<{ ok: boolean }>(
        `SELECT has_table_privilege('brainstrike_agent_readonly', 'file_symbols', 'SELECT')
            AND has_table_privilege('brainstrike_agent_readonly', 'file_symbol_refs', 'SELECT') AS ok`
      );
      expect(result.rows[0]?.ok).toBe(true);
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
          ref('file-a', 0, 'acquireLease', { fromSymbolId: 'file-a_sym_0' }),
          ref('file-a', 1, 'node:worker_threads', {
            kind: 'import',
            module: 'node:worker_threads',
          }),
        ]
      );

      const symbols = await db.query<{ exported: boolean; name: string }>(
        `SELECT name, exported FROM file_symbols WHERE file_record_id = 'file-a' ORDER BY id`
      );
      expect(symbols.rows).toEqual([
        { exported: true, name: 'startEmbeddingWorker' },
        { exported: false, name: 'helper' },
      ]);

      const refs = await db.query<{ from_symbol_id: string | null; kind: string; name: string }>(
        `SELECT name, kind, from_symbol_id FROM file_symbol_refs WHERE file_record_id = 'file-a' ORDER BY id`
      );
      expect(refs.rows).toEqual([
        { from_symbol_id: 'file-a_sym_0', kind: 'call', name: 'acquireLease' },
        { from_symbol_id: null, kind: 'import', name: 'node:worker_threads' },
      ]);
    });

    it('inserts nothing when both arrays are empty', async () => {
      await expect(repository.insertMany([], [])).resolves.toBeUndefined();
    });

    it('rejects a ref whose enclosing symbol is not in the same batch', async () => {
      // The intra-batch invariant is what makes from_symbol_id safe under
      // churn. A dangling enclosing id must FAIL, not insert an orphan edge.
      await seedFileRecord('file-a', 'src/a.ts');
      await expect(
        repository.insertMany(
          [symbol('file-a', 0, 'fn')],
          [ref('file-a', 0, 'other', { fromSymbolId: 'file-ZZZ_sym_9' })]
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
        [ref('file-a', 0, 'x', { fromSymbolId: 'file-a_sym_0' })]
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
    it('answers transitive callers via name join, admitted by the querySelf recursion guard shape', async () => {
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
        [ref('file-run', 0, 'startEmbeddingWorker', { fromSymbolId: 'file-run_sym_0' })]
      );
      await repository.insertMany(
        [symbol('file-main', 0, 'main')],
        [ref('file-main', 0, 'run', { fromSymbolId: 'file-main_sym_0' })]
      );
      await repository.insertMany(
        [symbol('file-unrelated', 0, 'other')],
        [ref('file-unrelated', 0, 'somethingElse', { fromSymbolId: 'file-unrelated_sym_0' })]
      );

      // The exact statement documented as the querySelf worked example: UNION
      // (dedup) + join-terminated + explicit depth bound — the shape the
      // recursion guard preserves (pinned in agent-sql-service.test.ts).
      const result = await db.query<{ depth: number; name: string; path: string }>(
        `WITH RECURSIVE callers(id, name, depth) AS (
           SELECT s.id, s.name, 0 FROM file_symbols s WHERE s.name = 'startEmbeddingWorker'
           UNION
           SELECT encl.id, encl.name, c.depth + 1
           FROM callers c
           JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
           JOIN file_symbols encl ON encl.id = r.from_symbol_id
           WHERE c.depth < 10
         )
         SELECT fr.path, c.name, c.depth
         FROM callers c
         JOIN file_symbols s ON s.id = c.id
         JOIN file_records fr ON fr.id = s.file_record_id
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
