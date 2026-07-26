import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSqlService } from '../src/search/agent-sql-service.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * The hybrid one-statement query (BST-935) — the original BST-919 pitch,
 * exercised for the first time: traverse the symbol graph recursively, join
 * the reachable files to the BM25 arm and the vector arm over `file_chunks`,
 * and fuse with RRF — in ONE statement, THROUGH the querySelf sandbox.
 *
 * This is deliberately an end-to-end proof against `AgentSqlService.query()`
 * rather than raw SQL: the sandbox's recursion guard, cost ceiling, restricted
 * role, and row-cap wrapper all sit between the model and this plan, and none
 * of them had ever seen a recursive traversal feeding index-backed search
 * arms. If a future guard change refuses this statement, that is a regression
 * in a headline capability, not a hardening win.
 *
 * The vector arm needs no external embedding: it self-joins on a STORED chunk
 * embedding (the chunk containing the seed symbol) as the query vector, so the
 * whole statement is expressible by the model with no out-of-band computation.
 */

/** The canonical statement, kept in sync with docs/agents/agent-self-query.md
 * and the querySelf tool description example. */
const HYBRID_ONE_STATEMENT = `
WITH RECURSIVE callers(file_record_id, seq, name, depth) AS (
  SELECT s.file_record_id, s.seq, s.name, 0
  FROM file_symbols s WHERE s.name = 'startEmbeddingWorker'
  UNION
  SELECT encl.file_record_id, encl.seq, encl.name, c.depth + 1
  FROM callers c
  JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
  JOIN file_symbols encl
    ON encl.file_record_id = r.file_record_id AND encl.seq = r.from_symbol_seq
  WHERE c.depth < 10
),
reachable AS (SELECT DISTINCT file_record_id FROM callers),
seed_embedding AS (
  SELECT ch.embedding
  FROM file_chunks ch
  JOIN file_symbols s ON s.file_record_id = ch.file_record_id
  WHERE s.name = 'startEmbeddingWorker' AND ch.embedding IS NOT NULL
  ORDER BY ch.id LIMIT 1
),
bm25_arm AS (
  SELECT ch.id, ROW_NUMBER() OVER (
    ORDER BY (-(ch.content <@> to_bm25query('embedding worker lease',
                                            'idx_file_chunks_content_bm25')))::float8
             DESC NULLS LAST, ch.id
  ) AS position
  FROM file_chunks ch
  JOIN reachable rf ON rf.file_record_id = ch.file_record_id
),
vector_arm AS (
  SELECT ch.id, ROW_NUMBER() OVER (
    ORDER BY ch.embedding <=> (SELECT embedding FROM seed_embedding), ch.id
  ) AS position
  FROM file_chunks ch
  JOIN reachable rf ON rf.file_record_id = ch.file_record_id
  WHERE ch.embedding IS NOT NULL
)
SELECT fr.path, ch.id AS chunk_id,
       sum(1.0 / (60 + arm.position))::float8 AS rrf_score
FROM (
  SELECT id, position FROM bm25_arm
  UNION ALL
  SELECT id, position FROM vector_arm
) arm
JOIN file_chunks ch ON ch.id = arm.id
JOIN file_records fr ON fr.id = ch.file_record_id
GROUP BY fr.path, ch.id
ORDER BY rrf_score DESC, fr.path
`;

describe('hybrid one-statement retrieval through the querySelf sandbox', () => {
  let db: PGlite;
  let service: AgentSqlService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new AgentSqlService(db);

    await db.query(
      `INSERT INTO roots (id, kind, display_name, path) VALUES ('root-fixture', 'path', 'fixture', '/workspace/root')`
    );

    // Call chain: main() -> run() -> startEmbeddingWorker(). other.ts is the
    // control: its chunk is BAIT for both arms (identical content and
    // embedding to the seed chunk) but it is unreachable in the graph, so its
    // appearance in the result would mean the traversal is not scoping the
    // arms at all.
    const files: [string, string][] = [
      ['file-worker', 'src/worker.ts'],
      ['file-run', 'src/run.ts'],
      ['file-main', 'src/main.ts'],
      ['file-other', 'src/other.ts'],
    ];
    for (const [id, path] of files) {
      await db.query(
        `INSERT INTO file_records (id, name, path, size, root_id)
         VALUES ($1, $2, $3, 10, 'root-fixture')`,
        [id, path.split('/').at(-1) ?? path, path]
      );
    }

    await db.query(
      `INSERT INTO file_symbols (file_record_id, seq, name, kind, exported, start_line, end_line, start_offset, end_offset)
       VALUES
         ('file-worker', 0, 'startEmbeddingWorker', 'function', true, 1, 20, 0, 400),
         ('file-run',    0, 'run',                  'function', true, 1, 20, 0, 400),
         ('file-main',   0, 'main',                 'function', true, 1, 20, 0, 400),
         ('file-other',  0, 'misc',                 'function', true, 1, 20, 0, 400)`
    );
    await db.query(
      `INSERT INTO file_symbol_refs (file_record_id, seq, name, kind, line, from_symbol_seq)
       VALUES
         ('file-run',  0, 'startEmbeddingWorker', 'call', 12, 0),
         ('file-main', 0, 'run',                  'call', 12, 0)`
    );

    // english text-search config does NOT split camelCase, so the seed chunk
    // carries the query terms in prose (as a real doc comment would) — twice,
    // so it wins the BM25 arm outright rather than by a length tiebreak.
    const seedContent =
      '/** embedding worker lease: acquires the embedding worker lease */ export function startEmbeddingWorker() {}';
    const chunks: [string, string, string, string][] = [
      ['chunk-worker', 'file-worker', seedContent, '[1,0,0]'],
      [
        'chunk-run',
        'file-run',
        'the run loop starts the embedding worker and holds its lease',
        '[0.9,0.1,0]',
      ],
      ['chunk-main', 'file-main', 'main entrypoint wires configuration and telemetry', '[0,1,0]'],
      // Bait: identical content AND embedding to the seed chunk.
      ['chunk-other', 'file-other', seedContent, '[1,0,0]'],
    ];
    for (const [id, fileRecordId, content, embedding] of chunks) {
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, embedding)
         VALUES ($1, $2, 0, $3, $4::vector)`,
        [id, fileRecordId, content, embedding]
      );
    }
  });

  afterEach(async () => {
    await db.close();
  });

  it('admits and answers the canonical hybrid statement', { timeout: 120_000 }, async () => {
    const result = await service.query(HYBRID_ONE_STATEMENT);

    expect(result.columns).toEqual(['path', 'chunk_id', 'rrf_score']);
    const paths = result.rows.map((row) => (row as unknown[])[0]);

    // Exactly the reachable files — the bait chunk in src/other.ts scores
    // identically on both arms and MUST still be absent.
    expect(new Set(paths)).toEqual(new Set(['src/worker.ts', 'src/run.ts', 'src/main.ts']));
    expect(paths).not.toContain('src/other.ts');

    // The seed chunk wins both arms (exact content match, zero vector
    // distance), so fusion must rank it first.
    expect(result.rows[0]?.[0]).toBe('src/worker.ts');

    const scores = result.rows.map((row) => (row as unknown[])[2] as number);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
    }
    // Descending fusion order.
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('the SAME statement survives EXPLAIN ANALYZE admission', { timeout: 120_000 }, async () => {
    // analyze uses boundedByRowCap: false — the strictest admission path. The
    // traversal is bounded below the Recursive Union (depth filter + join
    // conds), which is what makes it admissible with no row cap at all.
    const result = await service.explain(HYBRID_ONE_STATEMENT, { analyze: true });
    expect(result.analyzed).toBe(true);
    expect(result.plan.join('\n')).toContain('Recursive Union');
  });
});
