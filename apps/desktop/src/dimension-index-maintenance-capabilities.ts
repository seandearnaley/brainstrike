export type DimensionIndexBuildStrategy = 'concurrent' | 'regular';

export interface DimensionIndexRuntimeCapabilities {
  readonly concurrentIndexBuild: {
    readonly error: string | null;
    readonly foregroundProbeP95Ms: number | null;
    readonly supported: boolean;
  };
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

export interface DimensionIndexStrategySelection {
  readonly reason:
    | 'concurrent-index-build-blocks-foreground-db'
    | 'concurrent-index-build-supported-and-responsive'
    | 'concurrent-index-build-unmeasured'
    | 'concurrent-index-build-unsupported';
  readonly strategy: DimensionIndexBuildStrategy;
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

export interface InvalidDimensionIndex {
  readonly indexName: string;
  readonly isReady: boolean;
  readonly isValid: boolean;
}

const SCRATCH_TABLE_NAME_PATTERN = /^brainstrike_hnsw_probe_[a-z0-9_]+$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

function validateHealthThreshold(value: number): void {
  assertFiniteNonNegative(value, 'foregroundHealthThresholdMs');
  if (value === 0) {
    throw new Error('foregroundHealthThresholdMs must be greater than zero.');
  }
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

export function selectDimensionIndexStrategy(input: {
  readonly concurrentIndexBuild: DimensionIndexRuntimeCapabilities['concurrentIndexBuild'];
  readonly foregroundHealthThresholdMs: number;
}): DimensionIndexStrategySelection {
  validateHealthThreshold(input.foregroundHealthThresholdMs);

  if (!input.concurrentIndexBuild.supported) {
    return {
      reason: 'concurrent-index-build-unsupported',
      strategy: 'regular',
    };
  }

  const probeP95Ms = input.concurrentIndexBuild.foregroundProbeP95Ms;
  if (probeP95Ms === null) {
    return {
      reason: 'concurrent-index-build-unmeasured',
      strategy: 'regular',
    };
  }
  assertFiniteNonNegative(probeP95Ms, 'foregroundProbeP95Ms');

  if (probeP95Ms > input.foregroundHealthThresholdMs) {
    return {
      reason: 'concurrent-index-build-blocks-foreground-db',
      strategy: 'regular',
    };
  }

  return {
    reason: 'concurrent-index-build-supported-and-responsive',
    strategy: 'concurrent',
  };
}

export async function probeDimensionIndexRuntimeCapabilities(params: {
  readonly db: DimensionIndexCapabilityDb;
  readonly foregroundHealthProbe: () => Promise<{ readonly p95Ms: number }>;
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
  let concurrentIndexBuild: DimensionIndexRuntimeCapabilities['concurrentIndexBuild'] = {
    error: null,
    foregroundProbeP95Ms: null,
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

    try {
      await exec(`
        CREATE INDEX CONCURRENTLY brainstrike_hnsw_probe_concurrent_idx ON ${tableName}
        USING hnsw ((embedding::halfvec(3)) halfvec_cosine_ops)
      `);
      concurrentIndexBuild = {
        error: null,
        foregroundProbeP95Ms: null,
        supported: true,
      };
      await exec('DROP INDEX IF EXISTS brainstrike_hnsw_probe_concurrent_idx');
    } catch (error) {
      concurrentIndexBuild = {
        error: errorMessage(error),
        foregroundProbeP95Ms: null,
        supported: false,
      };
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
    concurrentIndexBuild,
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

export async function measureConcurrentIndexForegroundHealth(params: {
  readonly createConcurrentIndex: () => Promise<void>;
  readonly foregroundHealthProbe: () => Promise<{
    readonly maxMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly samples: number;
  }>;
}): Promise<{
  readonly createIndexCompleted: boolean;
  readonly foregroundProbeMaxMs: number;
  readonly foregroundProbeP50Ms: number;
  readonly foregroundProbeP95Ms: number;
  readonly foregroundProbeSamples: number;
}> {
  const [probe] = await Promise.all([
    params.foregroundHealthProbe(),
    params.createConcurrentIndex(),
  ]);
  assertFiniteNonNegative(probe.maxMs, 'foregroundProbeMaxMs');
  assertFiniteNonNegative(probe.p50Ms, 'foregroundProbeP50Ms');
  assertFiniteNonNegative(probe.p95Ms, 'foregroundProbeP95Ms');
  if (!Number.isSafeInteger(probe.samples) || probe.samples <= 0) {
    throw new Error('foregroundProbeSamples must be a positive safe integer.');
  }

  return {
    createIndexCompleted: true,
    foregroundProbeMaxMs: probe.maxMs,
    foregroundProbeP50Ms: probe.p50Ms,
    foregroundProbeP95Ms: probe.p95Ms,
    foregroundProbeSamples: probe.samples,
  };
}

export async function listInvalidDimensionIndexes(db: {
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: readonly TRecord[] }>;
}): Promise<readonly InvalidDimensionIndex[]> {
  const result = await db.query<{
    readonly indexName: string;
    readonly isReady: boolean;
    readonly isValid: boolean;
  }>(`
    SELECT c.relname AS "indexName",
           i.indisvalid AS "isValid",
           i.indisready AS "isReady"
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname LIKE 'idx_file_chunks_emb_hnsw_%'
       AND (i.indisvalid = false OR i.indisready = false)
     ORDER BY c.relname
  `);

  return result.rows.map((row) => ({
    indexName: row.indexName,
    isReady: row.isReady,
    isValid: row.isValid,
  }));
}
