export type DimensionIndexBuildStrategy = 'regular';

export interface DimensionIndexRuntimeCapabilities {
  readonly hnswIndexBuild: {
    readonly error: string | null;
    readonly supported: boolean;
  };
  readonly maintenanceSettings: {
    readonly initialMemoryBytes: number | null;
    readonly maintenanceWorkMem: string | null;
    readonly maxParallelMaintenanceWorkers: string | null;
    readonly maxParallelWorkers: string | null;
  };
  readonly progressReporting: {
    readonly error: string | null;
    readonly pgStatProgressCreateIndexReadable: boolean;
  };
}

interface DimensionIndexCapabilityDb {
  readonly maintenance?: {
    readonly exec: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  };
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: readonly TRecord[] }>;
}

const SCRATCH_TABLE_NAME_PATTERN = /^brainstrike_hnsw_probe_[a-z0-9_]+$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateScratchTableName(scratchTableName: string): void {
  if (!SCRATCH_TABLE_NAME_PATTERN.test(scratchTableName)) {
    throw new Error(
      `Invalid scratch table name "${scratchTableName}". Expected brainstrike_hnsw_probe_[a-z0-9_]+.`
    );
  }
}

function readFirstSetting(rows: readonly Record<string, unknown>[], key: string): string | null {
  const first = rows[0];
  if (!first) {
    return null;
  }
  const direct = first[key];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const firstValue = Object.values(first)[0];
  return typeof firstValue === 'string' && firstValue.length > 0 ? firstValue : null;
}

async function readSetting(
  db: Pick<DimensionIndexCapabilityDb, 'query'>,
  name: 'maintenance_work_mem' | 'max_parallel_maintenance_workers' | 'max_parallel_workers'
): Promise<string | null> {
  try {
    const result = await db.query<Record<string, unknown>>(`SHOW ${name}`);
    return readFirstSetting(result.rows, name);
  } catch {
    return null;
  }
}

export async function probeDimensionIndexRuntimeCapabilities(params: {
  readonly db: DimensionIndexCapabilityDb;
  readonly initialMemoryBytes: number | null;
  readonly now: () => Date;
  readonly scratchTableName: string;
}): Promise<DimensionIndexRuntimeCapabilities> {
  validateScratchTableName(params.scratchTableName);
  const probedAt = params.now();
  if (!(probedAt instanceof Date) || Number.isNaN(probedAt.getTime())) {
    throw new Error('Dimension index capability probe requires now() to return a valid Date.');
  }
  if (!params.db.maintenance?.exec) {
    throw new Error('Dimension index capability probe requires DB maintenance exec support.');
  }

  const exec = params.db.maintenance.exec;
  const tableName = params.scratchTableName;
  let hnswIndexBuild: DimensionIndexRuntimeCapabilities['hnswIndexBuild'] = {
    error: null,
    supported: false,
  };

  try {
    await exec(`DROP TABLE IF EXISTS ${tableName}`);
    await exec(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, embedding vector(3) NOT NULL)`);
    await exec(`
      INSERT INTO ${tableName} (id, embedding)
      VALUES
        (1, '[1,0,0]'::vector),
        (2, '[0,1,0]'::vector),
        (3, '[0,0,1]'::vector)
    `);

    try {
      await exec(`
        CREATE INDEX brainstrike_hnsw_probe_regular_idx ON ${tableName}
        USING hnsw ((embedding::halfvec(3)) halfvec_cosine_ops)
      `);
      hnswIndexBuild = { error: null, supported: true };
      await exec('DROP INDEX IF EXISTS brainstrike_hnsw_probe_regular_idx');
    } catch (error) {
      hnswIndexBuild = { error: errorMessage(error), supported: false };
    }
  } finally {
    await exec(`DROP TABLE IF EXISTS ${tableName}`);
  }

  const [maintenanceWorkMem, maxParallelMaintenanceWorkers, maxParallelWorkers] = await Promise.all(
    [
      readSetting(params.db, 'maintenance_work_mem'),
      readSetting(params.db, 'max_parallel_maintenance_workers'),
      readSetting(params.db, 'max_parallel_workers'),
    ]
  );

  let progressReporting: DimensionIndexRuntimeCapabilities['progressReporting'];
  try {
    await params.db.query('SELECT COUNT(*)::int AS count FROM pg_stat_progress_create_index');
    progressReporting = {
      error: null,
      pgStatProgressCreateIndexReadable: true,
    };
  } catch (error) {
    progressReporting = {
      error: errorMessage(error),
      pgStatProgressCreateIndexReadable: false,
    };
  }

  return {
    hnswIndexBuild,
    maintenanceSettings: {
      initialMemoryBytes: params.initialMemoryBytes,
      maintenanceWorkMem,
      maxParallelMaintenanceWorkers,
      maxParallelWorkers,
    },
    progressReporting,
  };
}
