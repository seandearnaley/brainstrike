import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BM25_CONTENT_INDEX_NAME, bm25RankExpression } from '../src/repositories/_shared.js';
import { AgentSqlService } from '../src/search/agent-sql-service.js';
import { seedHybridSymbolFixture } from './helpers/hybrid-symbol-fixture.js';
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

/** The canonical statement, kept in sync with the § "hybrid one-statement
 * query" subsection of docs/agents/agent-self-query.md. The querySelf tool
 * description carries only the two operator fragments, not this whole
 * statement. Both arms carry a match predicate and a per-arm LIMIT so the
 * enshrined shape is the one that stays admissible at scale — ROW_NUMBER
 * alone would hand RRF mass to zero-relevance chunks and rank every
 * reachable chunk twice. */
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
  SELECT ch.embedding, ch.embedding_set_id
  FROM file_chunks ch
  JOIN file_symbols s ON s.file_record_id = ch.file_record_id
  WHERE s.name = 'startEmbeddingWorker'
    AND ch.start_line <= s.start_line AND ch.end_line >= s.start_line
    AND ch.embedding IS NOT NULL
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
  WHERE ch.content_tsvector IS NOT NULL
    AND ch.content_tsvector @@ websearch_to_tsquery('english', 'embedding worker lease')
  ORDER BY 2
  LIMIT 50
),
vector_arm AS (
  SELECT ch.id, ROW_NUMBER() OVER (
    ORDER BY ch.embedding <=> (SELECT embedding FROM seed_embedding), ch.id
  ) AS position
  FROM file_chunks ch
  JOIN reachable rf ON rf.file_record_id = ch.file_record_id
  WHERE ch.embedding IS NOT NULL
    AND ch.embedding_set_id IS NOT DISTINCT FROM (SELECT embedding_set_id FROM seed_embedding)
  ORDER BY 2
  LIMIT 50
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

    await seedHybridSymbolFixture(db);
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

  it('the set scoping is load-bearing: without it, mixed dimensions abort', {
    timeout: 120_000,
  }, async () => {
    // Pins that the mixed-dimension fixture actually exercises the failure
    // the scoping exists for. If this stops failing, the fixture has gone
    // uniform again and the main test is no longer proving set safety.
    const unscoped = HYBRID_ONE_STATEMENT.replace(
      'AND ch.embedding_set_id IS NOT DISTINCT FROM (SELECT embedding_set_id FROM seed_embedding)',
      ''
    );
    expect(unscoped).not.toBe(HYBRID_ONE_STATEMENT);
    await expect(service.query(unscoped)).rejects.toThrow(/different vector dimensions/);
  });

  it('stays admitted at thousand-chunk scale, well under the cost ceiling', {
    timeout: 120_000,
  }, async () => {
    // The 5-chunk fixture cannot support a "far under the cost ceiling"
    // claim (#2033 review). Seed 2,000 filler chunks across the reachable
    // files — most matching the BM25 terms, all in the seed's embedding
    // set — so both arms genuinely rank at scale and the per-arm LIMITs
    // are what keep the statement's emitted work bounded.
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, embedding, embedding_set_id, start_line, end_line)
         SELECT 'bulk-' || i,
                (ARRAY['file-worker','file-run','file-main'])[1 + (i % 3)],
                100 + i,
                'filler block ' || i || ' embedding worker notes',
                ('[' || (i % 7) || ',' || (i % 11) || ',1]')::vector,
                'set-a',
                1000 + i, 1030 + i
         FROM generate_series(1, 2000) AS g(i)`
    );

    const result = await service.query(HYBRID_ONE_STATEMENT);
    // Measured 2026-07-26 at this fixture size: estimatedCost ≈ 472.
    expect(result.estimatedCost).toBeLessThan(50_000);
    // The seed chunk matches every BM25 term and is vector-distance zero to
    // itself, so it must still win fusion over 2,000 partial matches.
    expect(result.rows[0]?.[0]).toBe('src/worker.ts');
  });

  it('the PostgreSQL rank expression uses the installed BM25 index', {
    timeout: 120_000,
  }, async () => {
    const indexes = await db.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE indexname = $1',
      [BM25_CONTENT_INDEX_NAME]
    );
    expect(indexes.rows).toEqual([{ indexname: BM25_CONTENT_INDEX_NAME }]);
    await expect(
      service.query(`SELECT id FROM file_chunks ORDER BY ${bm25RankExpression("'x'")} DESC LIMIT 1`)
    ).resolves.toBeDefined();
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
