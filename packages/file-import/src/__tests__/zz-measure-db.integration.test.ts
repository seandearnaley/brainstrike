import { readFileSync } from 'node:fs';
import { FileSymbolRepository, migrate, wasmLoader } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import { toFileSymbolInserts } from '../chunking-worker-port';

const DATA =
  '/private/tmp/claude-501/-Users-seandearnaley-Documents-GitHub-brainstrike--claude-worktrees-brainstrike-unique-capabilities-d5175d/3c152282-c011-4182-88e1-085bd1a2528b/scratchpad/symbol-measure.json';

describe('measure db v2', () => {
  it('loads the monorepo symbol graph and measures it', { timeout: 600_000 }, async () => {
    const { rows } = JSON.parse(readFileSync(DATA, 'utf8'));
    const db = await wasmLoader.createPGlite('memory://measure2');
    await migrate(db);
    await db.exec(`INSERT INTO roots (id, kind, display_name, path) VALUES ('r','path','r','/')`);
    const repo = new FileSymbolRepository(db);
    const t0 = Date.now();
    let fileIndex = 0;
    for (const row of rows) {
      const fileId = `00000000-0000-4000-8000-${String(fileIndex).padStart(12, '0')}`;
      fileIndex += 1;
      await db.query(
        "INSERT INTO file_records (id, name, path, size, root_id) VALUES ($1, $2, $3, 1, 'r')",
        [fileId, row.file.split('/').at(-1), row.file]
      );
      const inserts = toFileSymbolInserts(fileId, row.symbols, row.refs, 'set-x');
      await repo.insertMany(inserts.symbols, inserts.refs);
    }
    const insertMs = Date.now() - t0;
    const sizes = await db.query(`
      SELECT 'file_symbols' AS t, pg_total_relation_size('file_symbols') AS bytes,
             (SELECT count(*) FROM file_symbols) AS rows_n
      UNION ALL
      SELECT 'file_symbol_refs', pg_total_relation_size('file_symbol_refs'),
             (SELECT count(*) FROM file_symbol_refs)`);
    const t1 = Date.now();
    const traversal = await db.query(`
      WITH RECURSIVE callers(file_record_id, seq, name, depth) AS (
        SELECT s.file_record_id, s.seq, s.name, 0 FROM file_symbols s WHERE s.name = 'extractSymbols'
        UNION
        SELECT encl.file_record_id, encl.seq, encl.name, c.depth + 1
        FROM callers c
        JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
        JOIN file_symbols encl
          ON encl.file_record_id = r.file_record_id AND encl.seq = r.from_symbol_seq
        WHERE c.depth < 10
      ) SELECT count(*)::int AS n FROM callers`);
    const traversalMs = Date.now() - t1;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ insertMs, sizes: sizes.rows, traversal: traversal.rows, traversalMs })
    );
    expect(fileIndex).toBeGreaterThan(500);
  });
});
