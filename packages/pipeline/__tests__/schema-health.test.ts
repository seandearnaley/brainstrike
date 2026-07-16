import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSchemaHealthChecker,
  formatHealthStatus,
  getRecommendedActions,
  type HealthCheckDb,
  hasRecoverableIssues,
  isSchemaReady,
  type SchemaHealthSummary,
} from '../src/schema-health.js';

// =============================================================================
// TEST FIXTURES
// =============================================================================

function createMockDb(overrides: Partial<HealthCheckDb> = {}): HealthCheckDb {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  };
}

function createHealthySummary(): SchemaHealthSummary {
  return {
    checkedAt: new Date().toISOString(),
    corruption: {
      invalidEmbeddingSetRefs: 0,
      invalidJobPayloads: 0,
      orphanedChunks: 0,
      stuckJobs: 0,
    },
    healthy: true,
    issues: [],
    tables: [
      { exists: true, issues: [], rowCount: 10, table: 'file_records' },
      { exists: true, issues: [], rowCount: 50, table: 'file_chunks' },
      { exists: true, issues: [], rowCount: 2, table: 'embedding_sets' },
      { exists: true, issues: [], rowCount: 0, table: 'job_queue' },
    ],
  };
}

function createUnhealthySummary(): SchemaHealthSummary {
  return {
    checkedAt: new Date().toISOString(),
    corruption: {
      invalidEmbeddingSetRefs: 0,
      invalidJobPayloads: 0,
      orphanedChunks: 5,
      stuckJobs: 3,
    },
    healthy: false,
    issues: [
      "Table 'embedding_sets' does not exist",
      'Found 3 stuck jobs past lease expiry',
      'Found 5 orphaned chunks without file records',
    ],
    tables: [
      { exists: true, issues: [], rowCount: 10, table: 'file_records' },
      { exists: true, issues: [], rowCount: 50, table: 'file_chunks' },
      { exists: false, issues: ["Table 'embedding_sets' does not exist"], table: 'embedding_sets' },
      { exists: true, issues: [], rowCount: 5, table: 'job_queue' },
    ],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createSchemaHealthChecker', () => {
  let mockDb: HealthCheckDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  describe('checkTablesExist', () => {
    it('returns results for all pipeline tables', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ exists: true }] }) // file_records exists
        .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // file_records count
        .mockResolvedValueOnce({ rows: [{ exists: true }] }) // file_chunks exists
        .mockResolvedValueOnce({ rows: [{ count: '50' }] }) // file_chunks count
        .mockResolvedValueOnce({ rows: [{ exists: true }] }) // embedding_sets exists
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // embedding_sets count
        .mockResolvedValueOnce({ rows: [{ exists: true }] }) // job_queue exists
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // job_queue count

      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const results = await checker.checkTablesExist();

      expect(results).toHaveLength(4);
      expect(results.map((r) => r.table)).toEqual([
        'file_records',
        'file_chunks',
        'embedding_sets',
        'job_queue',
      ]);
    });

    it('detects missing tables', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] }) // file_records missing
        .mockResolvedValueOnce({ rows: [{ exists: true }] }) // file_chunks exists
        .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // file_chunks count
        .mockResolvedValueOnce({ rows: [{ exists: false }] }) // embedding_sets missing
        .mockResolvedValueOnce({ rows: [{ exists: true }] }) // job_queue exists
        .mockResolvedValueOnce({ rows: [{ count: '5' }] }); // job_queue count

      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const results = await checker.checkTablesExist();

      const missingTables = results.filter((r) => !r.exists);
      expect(missingTables).toHaveLength(2);
      expect(missingTables[0]?.table).toBe('file_records');
      expect(missingTables[0]?.issues).toContain("Table 'file_records' does not exist");
    });

    it('handles query errors gracefully', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('Database connection failed'));

      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const results = await checker.checkTablesExist();

      expect(results[0]?.exists).toBe(false);
      expect(results[0]?.issues[0]).toContain('Failed to check table');
    });
  });

  describe('countOrphanedChunks', () => {
    it('counts orphaned chunks correctly', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '7' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const count = await checker.countOrphanedChunks();

      expect(count).toBe(7);
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN file_records'));
    });

    it('returns 0 when table does not exist', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('relation "file_chunks" does not exist'));
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const count = await checker.countOrphanedChunks();

      expect(count).toBe(0);
    });
  });

  describe('countStuckJobs', () => {
    it('counts stuck jobs with default timeout', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '3' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const count = await checker.countStuckJobs();

      expect(count).toBe(3);
      // Default timeout is 5 minutes = 300000ms
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('running'), [300_000]);
    });

    it('counts stuck jobs with custom timeout', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '5' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const count = await checker.countStuckJobs(60_000); // 1 minute

      expect(count).toBe(5);
      expect(queryFn).toHaveBeenCalledWith(expect.any(String), [60_000]);
    });

    it('returns 0 when table does not exist', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('relation "job_queue" does not exist'));
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const count = await checker.countStuckJobs();

      expect(count).toBe(0);
    });
  });

  describe('countInvalidEmbeddingSetRefs', () => {
    it('counts invalid references correctly', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '12' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const count = await checker.countInvalidEmbeddingSetRefs();

      expect(count).toBe(12);
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'));
    });
  });

  describe('checkHealth', () => {
    it('returns healthy summary when all tables exist and no corruption', async () => {
      const queryFn = vi
        .fn()
        // Table existence checks (4 tables × 2 queries each = 8 calls)
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        // Corruption checks (4 checks)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // orphanedChunks
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // stuckJobs
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // invalidEmbeddingSetRefs
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // invalidJobPayloads

      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const summary = await checker.checkHealth();

      expect(summary.healthy).toBe(true);
      expect(summary.issues).toHaveLength(0);
      expect(summary.tables.every((t) => t.exists)).toBe(true);
      expect(summary.corruption.orphanedChunks).toBe(0);
      expect(summary.corruption.stuckJobs).toBe(0);
    });

    it('returns unhealthy summary when tables are missing', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] }) // file_records missing
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        // Corruption checks
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const summary = await checker.checkHealth();

      expect(summary.healthy).toBe(false);
      expect(summary.issues).toContain("Table 'file_records' does not exist");
    });

    it('returns unhealthy summary when corruption detected', async () => {
      const queryFn = vi
        .fn()
        // All tables exist
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })
        // Corruption detected
        .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // orphanedChunks
        .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // stuckJobs
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const summary = await checker.checkHealth();

      expect(summary.healthy).toBe(false);
      expect(summary.corruption.orphanedChunks).toBe(5);
      expect(summary.corruption.stuckJobs).toBe(3);
      expect(summary.issues).toContain('Found 5 orphaned chunks without file records');
      expect(summary.issues).toContain('Found 3 stuck jobs past lease expiry');
    });

    it('includes timestamp in summary', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ exists: true }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const before = new Date().toISOString();
      const summary = await checker.checkHealth();
      const after = new Date().toISOString();

      expect(summary.checkedAt).toBeDefined();
      expect(summary.checkedAt >= before).toBe(true);
      expect(summary.checkedAt <= after).toBe(true);
    });
  });

  describe('cleanOrphanedChunks', () => {
    it('deletes orphaned chunks and returns count', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '5' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const result = await checker.cleanOrphanedChunks();

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(5);
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM file_chunks'));
    });

    it('returns error on failure', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('Permission denied'));
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const result = await checker.cleanOrphanedChunks();

      expect(result.success).toBe(false);
      expect(result.recoveredCount).toBe(0);
      expect(result.error).toContain('Permission denied');
    });
  });

  describe('recoverStuckJobs', () => {
    it('resets stuck jobs to queued state', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '3' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const result = await checker.recoverStuckJobs();

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(3);
      expect(queryFn).toHaveBeenCalledWith(
        expect.stringContaining("state = 'queued'"),
        expect.any(Array)
      );
    });

    it('uses custom timeout parameter', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '2' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      await checker.recoverStuckJobs(120_000);

      expect(queryFn).toHaveBeenCalledWith(expect.any(String), [120_000]);
    });
  });

  describe('cancelAllPendingJobs', () => {
    it('cancels all queued and running jobs', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '10' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const result = await checker.cancelAllPendingJobs();

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(10);
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining("state = 'canceled'"));
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining("IN ('queued', 'running')"));
    });

    it('folds the lifetime canceled counter into the same atomic statement', async () => {
      const queryFn = vi.fn().mockResolvedValue({ rows: [{ count: '3' }] });
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const result = await checker.cancelAllPendingJobs();

      expect(result.success).toBe(true);
      expect(queryFn).toHaveBeenCalledTimes(1);
      const sql = queryFn.mock.calls[0]?.[0] as string;
      // Mirrors incrementOutcomeMetricsCte in @brainstrike/db: the canceled CTE
      // exposes `queue` so the metrics INSERT can GROUP BY queue, all in one
      // atomic statement (aggregate-then-prune lifetime counters).
      expect(sql).toContain('RETURNING queue');
      expect(sql).toContain('INSERT INTO job_queue_metrics (queue, canceled_total)');
      expect(sql).toContain(
        'SET canceled_total = job_queue_metrics.canceled_total + EXCLUDED.canceled_total'
      );
    });
  });

  describe('clearForReindex', () => {
    it('clears all chunks and embedding jobs', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ count: '100' }] }) // deleted chunks
        .mockResolvedValueOnce({ rows: [{ count: '50' }] }) // deleted jobs
        .mockResolvedValueOnce({ rows: [] }); // update file_records

      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const result = await checker.clearForReindex();

      expect(result.success).toBe(true);
      expect(result.recoveredCount).toBe(150); // 100 chunks + 50 jobs
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM file_chunks'));
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining("job_type = 'embed_chunk'"));
      expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('UPDATE file_records'));
    });

    it('returns error if deletion fails', async () => {
      const queryFn = vi.fn().mockRejectedValue(new Error('Foreign key constraint'));
      mockDb = createMockDb({ query: queryFn });
      const checker = createSchemaHealthChecker(mockDb);

      const result = await checker.clearForReindex();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Foreign key constraint');
    });
  });
});

describe('isSchemaReady', () => {
  it('returns true when all tables exist', () => {
    const summary = createHealthySummary();
    expect(isSchemaReady(summary)).toBe(true);
  });

  it('returns false when any table is missing', () => {
    const summary = createUnhealthySummary();
    expect(isSchemaReady(summary)).toBe(false);
  });
});

describe('hasRecoverableIssues', () => {
  it('returns false for healthy schema', () => {
    const summary = createHealthySummary();
    expect(hasRecoverableIssues(summary)).toBe(false);
  });

  it('returns true for orphaned chunks', () => {
    const summary = createHealthySummary();
    summary.corruption.orphanedChunks = 5;
    expect(hasRecoverableIssues(summary)).toBe(true);
  });

  it('returns true for stuck jobs', () => {
    const summary = createHealthySummary();
    summary.corruption.stuckJobs = 3;
    expect(hasRecoverableIssues(summary)).toBe(true);
  });

  it('returns false for only missing tables (not recoverable)', () => {
    const summary: SchemaHealthSummary = {
      checkedAt: new Date().toISOString(),
      corruption: {
        invalidEmbeddingSetRefs: 0,
        invalidJobPayloads: 0,
        orphanedChunks: 0,
        stuckJobs: 0,
      },
      healthy: false,
      issues: ['missing table'],
      tables: [{ exists: false, issues: ['missing'], table: 'file_records' }],
    };
    expect(hasRecoverableIssues(summary)).toBe(false);
  });
});

describe('formatHealthStatus', () => {
  it('returns healthy message for healthy schema', () => {
    const summary = createHealthySummary();
    expect(formatHealthStatus(summary)).toBe('Schema is healthy');
  });

  it('includes missing tables in message', () => {
    const summary = createUnhealthySummary();
    const status = formatHealthStatus(summary);
    expect(status).toContain('Missing tables');
    expect(status).toContain('embedding_sets');
  });

  it('includes corruption metrics in message', () => {
    const summary = createUnhealthySummary();
    const status = formatHealthStatus(summary);
    expect(status).toContain('5 orphaned chunks');
    expect(status).toContain('3 stuck jobs');
  });

  it('handles multiple issues gracefully', () => {
    const summary = createUnhealthySummary();
    summary.corruption.invalidEmbeddingSetRefs = 2;
    const status = formatHealthStatus(summary);
    expect(status).toContain('2 invalid embedding refs');
  });
});

describe('getRecommendedActions', () => {
  it('returns empty array for healthy schema', () => {
    const summary = createHealthySummary();
    expect(getRecommendedActions(summary)).toEqual([]);
  });

  it('recommends running migrations for missing tables', () => {
    const summary = createUnhealthySummary();
    const actions = getRecommendedActions(summary);
    expect(actions.some((a) => a.action === 'runMigrations')).toBe(true);
  });

  it('recommends recovering stuck jobs', () => {
    const summary = createHealthySummary();
    summary.corruption.stuckJobs = 5;
    const actions = getRecommendedActions(summary);
    const action = actions.find((a) => a.action === 'recoverStuckJobs');
    expect(action).toBeDefined();
    expect(action?.description).toContain('5 stuck jobs');
  });

  it('recommends cleaning orphaned chunks', () => {
    const summary = createHealthySummary();
    summary.corruption.orphanedChunks = 10;
    const actions = getRecommendedActions(summary);
    const action = actions.find((a) => a.action === 'cleanOrphanedChunks');
    expect(action).toBeDefined();
    expect(action?.description).toContain('10 orphaned chunks');
  });

  it('recommends reindex for invalid embedding set refs', () => {
    const summary = createHealthySummary();
    summary.corruption.invalidEmbeddingSetRefs = 3;
    const actions = getRecommendedActions(summary);
    expect(actions.some((a) => a.action === 'clearForReindex')).toBe(true);
  });

  it('returns multiple actions when multiple issues exist', () => {
    const summary = createUnhealthySummary();
    const actions = getRecommendedActions(summary);
    expect(actions.length).toBeGreaterThanOrEqual(2);
  });
});
