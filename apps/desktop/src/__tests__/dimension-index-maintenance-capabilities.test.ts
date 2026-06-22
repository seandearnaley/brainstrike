import { describe, expect, it, vi } from 'vitest';
import {
  listInvalidDimensionIndexes,
  measureConcurrentIndexForegroundHealth,
  probeDimensionIndexRuntimeCapabilities,
  selectDimensionIndexStrategy,
} from '../dimension-index-maintenance-capabilities';

function createMockDb(
  options: {
    readonly failConcurrent?: boolean;
    readonly failHnsw?: boolean;
    readonly invalidIndexRows?: readonly {
      readonly indexName: string;
      readonly isReady: boolean;
      readonly isValid: boolean;
    }[];
    readonly progressViewFails?: boolean;
  } = {}
) {
  const exec = vi.fn(async (sql: string) => {
    if (options.failHnsw && sql.includes('USING hnsw')) {
      throw new Error('hnsw unavailable');
    }
    if (options.failConcurrent && sql.includes('CREATE INDEX CONCURRENTLY')) {
      throw new Error('concurrent unsupported');
    }
  });
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('maintenance_work_mem')) {
      return { rows: [{ maintenance_work_mem: '64MB' }] };
    }
    if (sql.includes('max_parallel_maintenance_workers')) {
      return { rows: [{ max_parallel_maintenance_workers: '2' }] };
    }
    if (sql.includes('max_parallel_workers')) {
      return { rows: [{ max_parallel_workers: '8' }] };
    }
    if (sql.includes('pg_stat_progress_create_index')) {
      if (options.progressViewFails) {
        throw new Error('progress view missing');
      }
      return { rows: [{ count: 0 }] };
    }
    if (sql.includes('pg_index') && sql.includes('pg_class')) {
      return { rows: [...(options.invalidIndexRows ?? [])] };
    }
    return { rows: [] };
  });

  return {
    db: { maintenance: { exec }, query },
    exec,
    query,
  };
}

describe('selectDimensionIndexStrategy', () => {
  it('selects concurrent strategy only when the runtime probe proves it usable', () => {
    const result = selectDimensionIndexStrategy({
      concurrentIndexBuild: {
        error: null,
        foregroundProbeP95Ms: 85,
        supported: true,
      },
      foregroundHealthThresholdMs: 5000,
    });

    expect(result).toEqual({
      reason: 'concurrent-index-build-supported-and-responsive',
      strategy: 'concurrent',
    });
  });

  it('selects regular idle-only strategy when concurrent build is unsupported and reports why', () => {
    const result = selectDimensionIndexStrategy({
      concurrentIndexBuild: {
        error: 'CREATE INDEX CONCURRENTLY is not supported in this PGlite runtime',
        foregroundProbeP95Ms: null,
        supported: false,
      },
      foregroundHealthThresholdMs: 5000,
    });

    expect(result).toEqual({
      reason: 'concurrent-index-build-unsupported',
      strategy: 'regular',
    });
  });

  it('marks concurrent strategy unusable when foreground health is worse than the release threshold', () => {
    const result = selectDimensionIndexStrategy({
      concurrentIndexBuild: {
        error: null,
        foregroundProbeP95Ms: 7500,
        supported: true,
      },
      foregroundHealthThresholdMs: 5000,
    });

    expect(result).toEqual({
      reason: 'concurrent-index-build-blocks-foreground-db',
      strategy: 'regular',
    });
  });

  it('does not choose concurrent when support exists but responsiveness has not been measured', () => {
    const result = selectDimensionIndexStrategy({
      concurrentIndexBuild: {
        error: null,
        foregroundProbeP95Ms: null,
        supported: true,
      },
      foregroundHealthThresholdMs: 5000,
    });

    expect(result).toEqual({
      reason: 'concurrent-index-build-unmeasured',
      strategy: 'regular',
    });
  });
});

describe('probeDimensionIndexRuntimeCapabilities', () => {
  it('probes HNSW and concurrent syntax through maintenance exec without measuring startup health', async () => {
    const { db, exec } = createMockDb();
    const foregroundHealthProbe = vi.fn(async () => ({ p95Ms: 1 }));

    const result = await probeDimensionIndexRuntimeCapabilities({
      db,
      foregroundHealthProbe,
      initialMemoryBytes: 268_435_456,
      now: () => new Date('2026-06-18T14:00:00.000Z'),
      scratchTableName: 'brainstrike_hnsw_probe_unit_test',
    });

    expect(result).toMatchObject({
      concurrentIndexBuild: {
        error: null,
        foregroundProbeP95Ms: null,
        supported: true,
      },
      hnswIndexBuild: {
        error: null,
        supported: true,
      },
      maintenanceSettings: {
        initialMemoryBytes: 268_435_456,
        maintenanceWorkMem: '64MB',
        maxParallelMaintenanceWorkers: '2',
        maxParallelWorkers: '8',
      },
      progressReporting: {
        error: null,
        pgStatProgressCreateIndexReadable: true,
      },
    });
    expect(foregroundHealthProbe).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE'));
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('USING hnsw'));
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('CREATE INDEX CONCURRENTLY'));
  });

  it('fails closed when maintenance exec support is unavailable', async () => {
    await expect(
      probeDimensionIndexRuntimeCapabilities({
        db: { query: vi.fn(async () => ({ rows: [] })) },
        foregroundHealthProbe: vi.fn(async () => ({ p95Ms: 1 })),
        initialMemoryBytes: null,
        now: () => new Date('2026-06-18T14:00:00.000Z'),
        scratchTableName: 'brainstrike_hnsw_probe_unit_test',
      })
    ).rejects.toThrow('Dimension index capability probe requires DB maintenance exec support.');
  });

  it('rejects unsafe scratch table names', async () => {
    const { db } = createMockDb();

    await expect(
      probeDimensionIndexRuntimeCapabilities({
        db,
        foregroundHealthProbe: vi.fn(async () => ({ p95Ms: 1 })),
        initialMemoryBytes: null,
        now: () => new Date('2026-06-18T14:00:00.000Z'),
        scratchTableName: 'file_chunks',
      })
    ).rejects.toThrow('Invalid scratch table name');
  });

  it('records unsupported concurrent syntax explicitly', async () => {
    const { db } = createMockDb({ failConcurrent: true });

    const result = await probeDimensionIndexRuntimeCapabilities({
      db,
      foregroundHealthProbe: vi.fn(async () => ({ p95Ms: 1 })),
      initialMemoryBytes: null,
      now: () => new Date('2026-06-18T14:00:00.000Z'),
      scratchTableName: 'brainstrike_hnsw_probe_unit_test',
    });

    expect(result.concurrentIndexBuild).toEqual({
      error: 'concurrent unsupported',
      foregroundProbeP95Ms: null,
      supported: false,
    });
  });
});

describe('measureConcurrentIndexForegroundHealth', () => {
  it('returns foreground health only after the concurrent build completes', async () => {
    const createConcurrentIndex = vi.fn(async () => undefined);
    const foregroundHealthProbe = vi.fn(async () => ({
      maxMs: 40,
      p50Ms: 10,
      p95Ms: 25,
      samples: 12,
    }));

    await expect(
      measureConcurrentIndexForegroundHealth({ createConcurrentIndex, foregroundHealthProbe })
    ).resolves.toEqual({
      createIndexCompleted: true,
      foregroundProbeMaxMs: 40,
      foregroundProbeP50Ms: 10,
      foregroundProbeP95Ms: 25,
      foregroundProbeSamples: 12,
    });
  });

  it('propagates build failures instead of returning partial measurements', async () => {
    await expect(
      measureConcurrentIndexForegroundHealth({
        createConcurrentIndex: vi.fn(async () => {
          throw new Error('concurrent build failed');
        }),
        foregroundHealthProbe: vi.fn(async () => ({
          maxMs: 40,
          p50Ms: 10,
          p95Ms: 25,
          samples: 12,
        })),
      })
    ).rejects.toThrow('concurrent build failed');
  });
});

describe('listInvalidDimensionIndexes', () => {
  it('returns invalid HNSW dimension indexes from pg_index', async () => {
    const { db } = createMockDb({
      invalidIndexRows: [
        {
          indexName: 'idx_file_chunks_emb_hnsw_384',
          isReady: false,
          isValid: false,
        },
      ],
    });

    await expect(listInvalidDimensionIndexes(db)).resolves.toEqual([
      {
        indexName: 'idx_file_chunks_emb_hnsw_384',
        isReady: false,
        isValid: false,
      },
    ]);
  });
});
