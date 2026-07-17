import { describe, expect, it } from 'vitest';
import type { PgliteDatabase, PgliteQueryResult } from '../types';
import { PgliteVectorStore } from '../vector-store';

const SET_WORK_MEM_RE = /^SET maintenance_work_mem = '(\d+)MB'$/;
const RESET_WORK_MEM = 'RESET maintenance_work_mem';

interface ScriptedDatabaseOptions {
  /** Reject the RESET maintenance_work_mem statement. */
  failReset?: boolean;
  /** Reject the sizing COUNT query instead of returning a row. */
  failRowCountEstimate?: boolean;
  /** Row count reported for the mastra_vectors sizing estimate. */
  rowCount: number;
}

/**
 * Scripted PgliteDatabase double recording every statement in dispatch order.
 * Routes just enough of the createIndex flow (schema init, index metadata
 * describe/insert, sizing COUNT, CREATE INDEX) to exercise the HNSW
 * build-memory tuning around the store's own exec/query handle.
 */
function createScriptedDatabase(options: ScriptedDatabaseOptions): {
  database: PgliteDatabase;
  statements: string[];
} {
  const statements: string[] = [];
  const record = (sql: string): string => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    statements.push(normalized);
    return normalized;
  };
  const database: PgliteDatabase = {
    exec: (sql: string): Promise<unknown> => {
      const normalized = record(sql);
      if (options.failReset && normalized === RESET_WORK_MEM) {
        return Promise.reject(new Error('simulated RESET failure'));
      }
      return Promise.resolve(undefined);
    },
    query: <TRecord extends Record<string, unknown> = Record<string, unknown>>(
      sql: string
    ): Promise<PgliteQueryResult<TRecord>> => {
      const normalized = record(sql);
      // Index metadata lookup (GROUP BY) must be routed before the sizing
      // estimate: both statements contain COUNT(*).
      if (normalized.includes('GROUP BY')) {
        return Promise.resolve({ rows: [] });
      }
      if (normalized.includes('COUNT(*)') && normalized.includes('mastra_vectors')) {
        if (options.failRowCountEstimate) {
          return Promise.reject(new Error('simulated COUNT failure'));
        }
        return Promise.resolve({
          rows: [{ count: String(options.rowCount) } as unknown as TRecord],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { database, statements };
}

function createIndexAt1024(database: PgliteDatabase): Promise<void> {
  const store = new PgliteVectorStore({ database });
  return store.createIndex({ dimension: 1024, indexName: 'memory_messages', metric: 'cosine' });
}

describe('PgliteVectorStore HNSW build maintenance_work_mem tuning', () => {
  it('raises maintenance_work_mem around the build when the estimated graph exceeds the default', async () => {
    const { database, statements } = createScriptedDatabase({ rowCount: 250_000 });

    await createIndexAt1024(database);

    const setIndex = statements.findIndex((sql) => SET_WORK_MEM_RE.test(sql));
    const createIndexPos = statements.findIndex((sql) =>
      sql.includes('CREATE INDEX IF NOT EXISTS idx_mastra_vectors_emb_hnsw_1024_cosine')
    );
    const resetIndex = statements.indexOf(RESET_WORK_MEM);
    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(createIndexPos).toBeGreaterThan(setIndex);
    expect(resetIndex).toBeGreaterThan(createIndexPos);

    const setStatement = statements[setIndex];
    const workMemMb = Number(setStatement?.match(SET_WORK_MEM_RE)?.[1]);
    expect(workMemMb).toBeGreaterThan(64);
  });

  it('skips the tuning statements when the estimated graph fits the 64MB default', async () => {
    const { database, statements } = createScriptedDatabase({ rowCount: 100 });

    await createIndexAt1024(database);

    expect(statements.some((sql) => sql.includes('maintenance_work_mem'))).toBe(false);
    expect(
      statements.some((sql) =>
        sql.includes('CREATE INDEX IF NOT EXISTS idx_mastra_vectors_emb_hnsw_1024_cosine')
      )
    ).toBe(true);
  });

  it('degrades to default sizing when the row estimate fails, without blocking the build', async () => {
    const { database, statements } = createScriptedDatabase({
      failRowCountEstimate: true,
      rowCount: 250_000,
    });

    await createIndexAt1024(database);

    expect(statements.some((sql) => sql.includes('maintenance_work_mem'))).toBe(false);
    expect(
      statements.some((sql) =>
        sql.includes('CREATE INDEX IF NOT EXISTS idx_mastra_vectors_emb_hnsw_1024_cosine')
      )
    ).toBe(true);
  });

  it('serializes concurrent builds for different dimension keys (no SET/RESET interleaving)', async () => {
    // maintenance_work_mem is session-global on PGlite's single shared
    // connection: if two builds interleave, one build's RESET can land between
    // the other's SET and CREATE INDEX, silently dropping that build back to
    // the slow 64MB default.
    const { database, statements } = createScriptedDatabase({ rowCount: 250_000 });
    const store = new PgliteVectorStore({ database });

    await Promise.all([
      store.createIndex({ dimension: 1024, indexName: 'memory_messages', metric: 'cosine' }),
      store.createIndex({ dimension: 1536, indexName: 'observational_memory', metric: 'cosine' }),
    ]);

    const tuningFlow = statements
      .map((sql) => {
        if (SET_WORK_MEM_RE.test(sql)) {
          return 'SET';
        }
        if (sql === RESET_WORK_MEM) {
          return 'RESET';
        }
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_mastra_vectors_emb_hnsw_')) {
          return 'CREATE';
        }
        return null;
      })
      .filter((step): step is string => step !== null);
    expect(tuningFlow).toEqual(['SET', 'CREATE', 'RESET', 'SET', 'CREATE', 'RESET']);
  });

  it('rejects when RESET fails after a successful build (leaked setting must be loud)', async () => {
    const { database, statements } = createScriptedDatabase({ failReset: true, rowCount: 250_000 });

    await expect(createIndexAt1024(database)).rejects.toThrow('simulated RESET failure');
    expect(
      statements.some((sql) =>
        sql.includes('CREATE INDEX IF NOT EXISTS idx_mastra_vectors_emb_hnsw_1024_cosine')
      )
    ).toBe(true);
    expect(statements.at(-1)).toBe(RESET_WORK_MEM);
  });
});
