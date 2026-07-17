import { describe, expect, it, vi } from 'vitest';
import { probeDimensionIndexRuntimeCapabilities } from '../dimension-index-maintenance-capabilities';

function createMockDb(
  options: { readonly failHnsw?: boolean; readonly progressViewFails?: boolean } = {}
) {
  const exec = vi.fn(async (sql: string) => {
    if (options.failHnsw && sql.includes('USING hnsw')) {
      throw new Error('hnsw unavailable');
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
    return { rows: [] };
  });

  return {
    db: { maintenance: { exec }, query },
    exec,
    query,
  };
}

describe('probeDimensionIndexRuntimeCapabilities', () => {
  it('probes HNSW support and settings without any CONCURRENTLY statements', async () => {
    const { db, exec } = createMockDb();

    const result = await probeDimensionIndexRuntimeCapabilities({
      db,
      initialMemoryBytes: 268_435_456,
      now: () => new Date('2026-06-18T14:00:00.000Z'),
      scratchTableName: 'brainstrike_hnsw_probe_unit_test',
    });

    expect(result).toEqual({
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
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE'));
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('USING hnsw'));
    for (const call of exec.mock.calls) {
      expect(call[0]).not.toContain('CONCURRENTLY');
    }
  });

  it('fails closed when maintenance exec support is unavailable', async () => {
    await expect(
      probeDimensionIndexRuntimeCapabilities({
        db: { query: vi.fn(async () => ({ rows: [] })) },
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
        initialMemoryBytes: null,
        now: () => new Date('2026-06-18T14:00:00.000Z'),
        scratchTableName: 'file_chunks',
      })
    ).rejects.toThrow('Invalid scratch table name');
  });

  it('records unsupported HNSW builds explicitly', async () => {
    const { db } = createMockDb({ failHnsw: true });

    const result = await probeDimensionIndexRuntimeCapabilities({
      db,
      initialMemoryBytes: null,
      now: () => new Date('2026-06-18T14:00:00.000Z'),
      scratchTableName: 'brainstrike_hnsw_probe_unit_test',
    });

    expect(result.hnswIndexBuild).toEqual({
      error: 'hnsw unavailable',
      supported: false,
    });
  });

  it('records unreadable progress reporting explicitly', async () => {
    const { db } = createMockDb({ progressViewFails: true });

    const result = await probeDimensionIndexRuntimeCapabilities({
      db,
      initialMemoryBytes: null,
      now: () => new Date('2026-06-18T14:00:00.000Z'),
      scratchTableName: 'brainstrike_hnsw_probe_unit_test',
    });

    expect(result.progressReporting).toEqual({
      error: 'progress view missing',
      pgStatProgressCreateIndexReadable: false,
    });
  });
});
