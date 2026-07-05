import type { BrainstrikeDbExecutionClient, ProfileBootstrapRuntime } from '@brainstrike/db';
import { createProfileBootstrapReport } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { createTursoBrowserEmbeddingWorkerStorage } from '../vector-status/turso-browser-embedding-worker-storage';

const BROWSER_TURSO_RUNTIME: ProfileBootstrapRuntime = {
  engine: 'turso',
  host: 'browser',
  persistence: 'opfs',
};

interface IssuedStatement {
  readonly params: readonly unknown[];
  readonly sql: string;
}

interface ScriptedExecutionClient extends BrainstrikeDbExecutionClient {
  readonly issued: readonly IssuedStatement[];
}

function createReadyBrowserTursoReport(overrides?: {
  readonly phase?: 'probing-capabilities' | 'ready';
  readonly runtime?: ProfileBootstrapRuntime;
}) {
  const phase = overrides?.phase ?? 'ready';
  return createProfileBootstrapReport({
    capabilities: { concurrentWrites: false, journalMode: 'wal' },
    checks: [
      {
        id: 'store.open',
        label: 'Browser Turso WASM store opens',
        required: true,
        status: phase === 'ready' ? 'passed' : 'pending',
      },
    ],
    phase,
    profileId: 'browser-turso-test',
    runtime: overrides?.runtime ?? BROWSER_TURSO_RUNTIME,
    search: {
      indexedSearch: 'available',
      message: 'Browser Turso WASM primary store is single-writer (test fixture).',
      ownershipMode: 'split-search-index-store',
    },
    startedAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:01.000Z',
  });
}

function createClaimableJobRow(leaseToken: unknown): Record<string, unknown> {
  return {
    attempts: 1,
    backoff_ms: 0,
    chunk_id: 'chunk-1',
    created_at: '2026-07-05T00:00:00.000Z',
    dedupe_key: null,
    embedding_set_id: 'set-1',
    error: null,
    id: 'job-1',
    job_type: 'embed_chunk',
    lease_token: leaseToken,
    leased_until: '2026-07-05T00:10:00.000Z',
    max_attempts: 5,
    payload: JSON.stringify({ chunkId: 'chunk-1', embeddingSetId: 'set-1' }),
    queue: 'embeddings',
    run_at: '2026-07-05T00:00:00.000Z',
    state: 'running',
    updated_at: '2026-07-05T00:00:01.000Z',
    worker_id: 'worker-a',
  };
}

function createScriptedExecutionClient(options?: {
  readonly throwOnQuery?: Error;
}): ScriptedExecutionClient {
  const issued: IssuedStatement[] = [];

  const query = async <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: TRecord[] }> => {
    issued.push({ params: params ?? [], sql });
    if (options?.throwOnQuery) {
      throw options.throwOnQuery;
    }
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT * FROM job_queue WHERE queue = ?')) {
      return { rows: [createClaimableJobRow(null)] as TRecord[] };
    }
    if (normalized.startsWith('UPDATE job_queue') && normalized.includes('RETURNING *')) {
      // The claim UPDATE binds the fresh lease token as its first parameter.
      return { rows: [createClaimableJobRow(params?.[0] ?? null)] as TRecord[] };
    }
    return { rows: [] };
  };

  const exec = async (sql: string, params?: readonly unknown[]): Promise<void> => {
    issued.push({ params: params ?? [], sql });
    if (options?.throwOnQuery) {
      throw options.throwOnQuery;
    }
  };

  const client: ScriptedExecutionClient = {
    exec,
    issued,
    query,
    transaction: async (callback) => {
      issued.push({ params: [], sql: 'BEGIN' });
      const result = await callback({ exec, query });
      issued.push({ params: [], sql: 'COMMIT' });
      return result;
    },
  };
  return client;
}

describe('createTursoBrowserEmbeddingWorkerStorage', () => {
  it('fails closed when the bootstrap report runtime is not browser Turso', () => {
    const client = createScriptedExecutionClient();
    expect(() =>
      createTursoBrowserEmbeddingWorkerStorage({
        client,
        report: createReadyBrowserTursoReport({
          runtime: { engine: 'turso', host: 'electron-utility', persistence: 'filesystem' },
        }),
      })
    ).toThrow(/engine 'turso'.*host 'browser'|browser Turso/i);

    expect(() =>
      createTursoBrowserEmbeddingWorkerStorage({
        client,
        report: createReadyBrowserTursoReport({
          runtime: { engine: 'pglite', host: 'browser', persistence: 'idb' },
        }),
      })
    ).toThrow(/browser Turso/i);
  });

  it('fails closed when the bootstrap report is not ready (no PGlite fallback)', () => {
    const client = createScriptedExecutionClient();
    expect(() =>
      createTursoBrowserEmbeddingWorkerStorage({
        client,
        report: createReadyBrowserTursoReport({ phase: 'probing-capabilities' }),
      })
    ).toThrow(/ready.*bootstrap report.*fail(s|ing)? closed|fail(s|ing)? closed.*ready/i);
  });

  it('fails closed when the client lacks execution-client capabilities', () => {
    expect(() =>
      createTursoBrowserEmbeddingWorkerStorage({
        client: { query: async () => ({ rows: [] }) } as unknown as BrainstrikeDbExecutionClient,
        report: createReadyBrowserTursoReport(),
      })
    ).toThrow(/capabilit/i);
  });

  it('claims jobs with lease tokens through the Turso queue over the provider-owned client', async () => {
    const client = createScriptedExecutionClient();
    const storage = createTursoBrowserEmbeddingWorkerStorage({
      client,
      report: createReadyBrowserTursoReport(),
    });

    const claimed = await storage.queue.claimMany({
      leaseMs: 60_000,
      limit: 1,
      queue: 'embeddings',
      workerId: 'worker-a',
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: 'job-1', state: 'running' });
    expect(typeof claimed[0]?.lease_token).toBe('string');
    expect(claimed[0]?.lease_token.length).toBeGreaterThan(0);

    // The claim mutation must run inside a serialized transaction and keep the
    // lease-token CAS shape (multi-tab remains a hazard until proven otherwise).
    const sqlList = client.issued.map((statement) => statement.sql.replace(/\s+/g, ' ').trim());
    expect(sqlList).toContain('BEGIN');
    expect(sqlList).toContain('COMMIT');
    const claimUpdate = sqlList.find((sql) => sql.startsWith('UPDATE job_queue'));
    expect(claimUpdate).toContain("state = 'running'");
    expect(claimUpdate).toContain('lease_token = ?');
  });

  it('keeps the lease-token guard on heartbeat', async () => {
    const client = createScriptedExecutionClient();
    const storage = createTursoBrowserEmbeddingWorkerStorage({
      client,
      report: createReadyBrowserTursoReport(),
    });

    await storage.queue.heartbeatBatch([{ id: 'job-1', leaseToken: 'lease-token-1' }], 30_000);

    const heartbeatSql = client.issued
      .map((statement) => statement.sql.replace(/\s+/g, ' ').trim())
      .find((sql) => sql.startsWith('UPDATE job_queue') && sql.includes('leased_until = ?'));
    expect(heartbeatSql).toContain('AND lease_token = ?');
    expect(heartbeatSql).toContain("AND state = 'running'");
  });

  it('wraps ownership-loss errors with a fail-closed single-writer diagnostic', async () => {
    const ownershipLoss = new TypeError('The database connection is not open');
    const client = createScriptedExecutionClient({ throwOnQuery: ownershipLoss });
    const storage = createTursoBrowserEmbeddingWorkerStorage({
      client,
      report: createReadyBrowserTursoReport(),
    });

    const claim = storage.queue.claimMany({ leaseMs: 60_000, queue: 'embeddings' });
    await expect(claim).rejects.toThrow(/single-writer ownership/i);
    await expect(claim).rejects.toThrow(/failing closed/i);
    await expect(claim).rejects.toMatchObject({ cause: ownershipLoss });
  });

  it('classifies lost OPFS access handles as ownership loss', async () => {
    const accessHandleLoss = new Error(
      'NoModificationAllowedError: Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.'
    );
    const client = createScriptedExecutionClient({ throwOnQuery: accessHandleLoss });
    const storage = createTursoBrowserEmbeddingWorkerStorage({
      client,
      report: createReadyBrowserTursoReport(),
    });

    await expect(storage.loadChunksByIds(['chunk-1'])).rejects.toThrow(/single-writer ownership/i);
  });

  it('passes non-ownership errors through unchanged', async () => {
    const sqlError = new Error('near "SELEC": syntax error');
    const client = createScriptedExecutionClient({ throwOnQuery: sqlError });
    const storage = createTursoBrowserEmbeddingWorkerStorage({
      client,
      report: createReadyBrowserTursoReport(),
    });

    await expect(storage.queue.claimMany({ leaseMs: 60_000, queue: 'embeddings' })).rejects.toBe(
      sqlError
    );
  });

  it('routes stats refresh through the shared Turso stats service over the client', async () => {
    const client = createScriptedExecutionClient();
    const storage = createTursoBrowserEmbeddingWorkerStorage({
      client,
      report: createReadyBrowserTursoReport(),
    });

    const log = vi.fn();
    const controller = storage.createStatsRefreshController({
      completedChunkThreshold: 1,
      log,
      minIntervalMs: 0,
      now: () => 1000,
    });
    await controller.recordCompletions(['set-1'], 1);
    await controller.flush('queue-idle');

    const statsSql = client.issued
      .map((statement) => statement.sql.replace(/\s+/g, ' ').trim())
      .filter((sql) => sql.includes('collection_indexing_stats'));
    expect(statsSql.length).toBeGreaterThan(0);
  });
});
