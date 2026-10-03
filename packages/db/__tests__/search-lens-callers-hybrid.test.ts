import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coerceLensValues, parseLensFile } from '@brainstrike/assistant-contract';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSqlService } from '../src/search/agent-sql-service.js';
import {
  HYBRID_FIXTURE_SYMBOL,
  HYBRID_FIXTURE_TERMS,
  seedHybridSymbolFixture,
} from './helpers/hybrid-symbol-fixture.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Golden for the currently shipped PGlite caller lens (BST-1924). Read the
 * actual artifact and verify its declared target before the REAL pipeline:
 * contract parser → declared-type coercion → sandbox execution with true
 * bind parameters. The artifact retains the proven web hybrid
 * statement; if someone edits it into an unparseable or unadmittable shape,
 * this fails, not a live model run.
 */

const LENS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.brainstrike/lenses/callers-hybrid.sql'
);

describe('shipped PGlite caller lens routing and execution', () => {
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

  it('parses with the contract grammar and declares (symbol, terms)', () => {
    const parsed = parseLensFile('callers-hybrid.sql', readFileSync(LENS_PATH, 'utf8'));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.lens.id).toBe('callers-hybrid');
    expect(parsed.lens.target).toBe('app');
    expect(parsed.lens.params.map((param) => `${param.name}:${param.type}`)).toEqual([
      'symbol:text',
      'terms:text',
    ]);
  });

  it('executes through the sandbox with bound values and honors graph scoping', {
    timeout: 120_000,
  }, async () => {
    const parsed = parseLensFile('callers-hybrid.sql', readFileSync(LENS_PATH, 'utf8'));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.lens.target).toBe('app');
    const coerced = coerceLensValues(parsed.lens.params, [
      HYBRID_FIXTURE_SYMBOL,
      HYBRID_FIXTURE_TERMS,
    ]);
    if (!coerced.ok) {
      throw new Error(coerced.error);
    }

    const result = await service.query(parsed.lens.sql, { params: coerced.values });

    expect(result.columns).toEqual(['path', 'chunk_id', 'start_line', 'end_line', 'rrf_score']);
    const paths = result.rows.map((row) => (row as unknown[])[0]);
    // The bait chunk (identical content/embedding, graph-unreachable) must
    // be absent, and the seed chunk must win fusion — the same behavioral
    // contract the inline BST-935 statement pins.
    expect(paths).not.toContain('src/other.ts');
    expect(new Set(paths)).toEqual(new Set(['src/worker.ts', 'src/run.ts', 'src/main.ts']));
    expect(result.rows[0]?.[0]).toBe('src/worker.ts');
  });

  it('a hostile text value stays a bind — never SQL', { timeout: 120_000 }, async () => {
    const parsed = parseLensFile('callers-hybrid.sql', readFileSync(LENS_PATH, 'utf8'));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.lens.target).toBe('app');
    const hostile = `x'; DROP TABLE file_symbols; --`;
    const result = await service.query(parsed.lens.sql, {
      params: [hostile, HYBRID_FIXTURE_TERMS],
    });
    // No symbol by that name → empty result, and the table survives.
    expect(result.rows).toEqual([]);
    const stillThere = await service.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'file_symbols'`
    );
    expect(stillThere.rows).toEqual([[1]]);
  });
});
