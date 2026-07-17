/**
 * Helper functions for creating and managing dimension-based HNSW indexes.
 * These indexes use partial indexes with expression casting to support
 * multiple embedding dimensions in a single dimensionless VECTOR column.
 *
 * SECURITY NOTE: All functions that interpolate values into SQL must validate
 * those values first to prevent SQL injection. Dimension and HNSW parameters
 * are validated before being used in SQL strings.
 */

import { createLogger } from '@brainstrike/utils';

const logger = createLogger('DimensionIndexHelpers');

interface HnswParams {
  ef: number;
  m: number;
}

/**
 * Maximum dimension for validation (theoretical limit for vector storage).
 */
const MAX_DIMENSION = 65_535;

/**
 * Maximum dimension supported by pgvector's HNSW index.
 * Vectors with more dimensions can still be stored and queried,
 * but without HNSW index acceleration (falls back to sequential scan).
 * @see https://github.com/pgvector/pgvector#hnsw
 */
// halfvec HNSW indexes support up to 4000 dimensions (vs 2000 for full-precision
// vector). The dimension index helpers build halfvec indexes, so the ceiling is 4000.
export const MAX_HNSW_DIMENSION = 4000;

/**
 * Maximum allowed value for HNSW M parameter.
 * Higher values use more memory but may improve recall.
 */
const MAX_HNSW_M = 1000;

/**
 * Maximum allowed value for HNSW ef_construction parameter.
 * Higher values build better indexes but take longer.
 */
const MAX_HNSW_EF = 10_000;

/**
 * Validates a dimension value for safe use in SQL interpolation.
 * @throws Error if dimension is not a safe positive integer within bounds
 */
function validateDimensionForSql(dimension: number, context: string): void {
  if (
    typeof dimension !== 'number' ||
    !Number.isInteger(dimension) ||
    dimension <= 0 ||
    dimension > MAX_DIMENSION
  ) {
    throw new Error(
      `${context}: Invalid dimension ${dimension}. Must be integer between 1 and ${MAX_DIMENSION}.`
    );
  }
}

/**
 * Validates HNSW parameters for safe use in SQL interpolation.
 * @throws Error if parameters are not safe positive integers within bounds
 */
function validateHnswParamsForSql(params: HnswParams, context: string): void {
  if (
    typeof params.m !== 'number' ||
    !Number.isInteger(params.m) ||
    params.m <= 0 ||
    params.m > MAX_HNSW_M
  ) {
    throw new Error(
      `${context}: Invalid HNSW m parameter ${params.m}. Must be integer between 1 and ${MAX_HNSW_M}.`
    );
  }

  if (
    typeof params.ef !== 'number' ||
    !Number.isInteger(params.ef) ||
    params.ef <= 0 ||
    params.ef > MAX_HNSW_EF
  ) {
    throw new Error(
      `${context}: Invalid HNSW ef_construction parameter ${params.ef}. Must be integer between 1 and ${MAX_HNSW_EF}.`
    );
  }
}

interface DimensionIndexDb {
  exec(sql: string, params?: unknown): Promise<unknown>;
  query<T = unknown>(sql: string, params?: unknown): Promise<{ rows: T[] }>;
}

/**
 * PGlite's compiled-in default for maintenance_work_mem. Builds whose estimated
 * HNSW graph fits inside the default skip the tuning statements entirely, so
 * small-table builds (fresh DBs, migration 014) behave exactly as before.
 */
export const DEFAULT_MAINTENANCE_WORK_MEM_MB = 64;

/**
 * Ceiling for the per-build maintenance_work_mem raise. PGlite runs in 32-bit
 * WASM, so the whole instance (shared_buffers + heap + build memory) must stay
 * well under the address-space ceiling — 512MB keeps total usage under ~1GB
 * headroom. 512MB is also the benchmarked value: at 100k chunks x 1024 dims the
 * ~260MB halfvec HNSW graph spills past the 64MB default and the build takes
 * 2,496s of fully-blocked single-connection DB; with 512MB it drops 5x to 505s
 * (benchmarked 2026-07-11, no schema or recall change).
 */
export const MAX_INDEX_BUILD_MAINTENANCE_WORK_MEM_MB = 512;

const HALFVEC_BYTES_PER_DIMENSION = 2;

/**
 * Per-row HNSW graph overhead beyond the raw halfvec payload: neighbor lists
 * (m*2 links at layer 0 plus upper layers) and element struct/alignment.
 * Calibrated against the 2026-07-11 benchmark: 100k x 1024-dim rows produced a
 * ~260MB graph vs 204.8MB raw halfvec (~550B/row overhead).
 */
const HNSW_GRAPH_OVERHEAD_BYTES_PER_ROW = 600;

/**
 * Multiplier over the estimated graph bytes so the in-memory build phase never
 * runs at the exact estimate (allocator overhead in WASM, estimate drift).
 */
const HNSW_BUILD_MEMORY_HEADROOM = 1.5;

/**
 * Size maintenance_work_mem for an HNSW build against the estimated graph:
 * rows x (dims x 2 bytes for halfvec + per-row neighbor-list overhead), with
 * headroom, clamped to [default, cap]. The pgvector build only spills to the
 * slow disk-based path when the graph exceeds maintenance_work_mem, and the
 * setting is a ceiling (not an upfront allocation), so a mild overestimate is
 * free; the cap is what protects the 32-bit WASM address space.
 */
export function resolveIndexBuildMaintenanceWorkMemMb(rowCount: number, dimension: number): number {
  if (!Number.isFinite(rowCount) || rowCount <= 0) {
    return DEFAULT_MAINTENANCE_WORK_MEM_MB;
  }
  const estimatedGraphBytes =
    rowCount * (dimension * HALFVEC_BYTES_PER_DIMENSION + HNSW_GRAPH_OVERHEAD_BYTES_PER_ROW);
  const estimatedMb = Math.ceil((estimatedGraphBytes * HNSW_BUILD_MEMORY_HEADROOM) / (1024 * 1024));
  return Math.min(
    Math.max(estimatedMb, DEFAULT_MAINTENANCE_WORK_MEM_MB),
    MAX_INDEX_BUILD_MAINTENANCE_WORK_MEM_MB
  );
}

/**
 * Best-effort row estimate for build-memory sizing. Counts every embedded row
 * rather than filtering by vector_dims(): the NULL check avoids detoasting the
 * vectors, and over-counting across dimensions only nudges the (capped) memory
 * ceiling upward. A failed count degrades to the default setting with a
 * visible warning — sizing must never block the build itself.
 */
async function estimateEmbeddedRowCount(db: Pick<DimensionIndexDb, 'query'>): Promise<number> {
  try {
    const result = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM file_chunks WHERE embedding IS NOT NULL'
    );
    const count = Number(result.rows[0]?.count ?? 0);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch (error) {
    logger.warn(
      'Failed to estimate embedded row count for HNSW build memory sizing; using default maintenance_work_mem',
      { error: error instanceof Error ? error.message : String(error) }
    );
    return 0;
  }
}

/**
 * Run an HNSW index build with maintenance_work_mem sized for the estimated
 * graph (embedded row count x dimension, see
 * resolveIndexBuildMaintenanceWorkMemMb). The SET only fires when the resolved
 * value exceeds the 64MB default, and the RESET always runs in a finally:
 * PGlite is one shared connection, so a leaked setting would ride along in
 * every subsequent query's session. `db.exec` MUST be the same channel/session
 * that executes the build itself (see the desktop maintenance scheduler and
 * embedding backfill), or the session-scoped SET silently would not apply.
 */
export async function withIndexBuildMaintenanceWorkMem(
  db: DimensionIndexDb,
  dimension: number,
  build: () => Promise<void>
): Promise<void> {
  const workMemMb = resolveIndexBuildMaintenanceWorkMemMb(
    await estimateEmbeddedRowCount(db),
    dimension
  );
  // Defense-in-depth before SQL interpolation: the resolver clamps to
  // [default, cap], so anything else is a bug.
  if (
    !Number.isInteger(workMemMb) ||
    workMemMb < DEFAULT_MAINTENANCE_WORK_MEM_MB ||
    workMemMb > MAX_INDEX_BUILD_MAINTENANCE_WORK_MEM_MB
  ) {
    throw new Error(
      `withIndexBuildMaintenanceWorkMem: Invalid maintenance_work_mem value: ${workMemMb}`
    );
  }
  const tuneBuildMemory = workMemMb > DEFAULT_MAINTENANCE_WORK_MEM_MB;
  let buildFailed = false;
  let buildError: unknown;

  try {
    if (tuneBuildMemory) {
      await db.exec(`SET maintenance_work_mem = '${workMemMb}MB'`);
    }
    await build();
  } catch (error) {
    buildFailed = true;
    buildError = error;
  }

  if (tuneBuildMemory) {
    try {
      await db.exec('RESET maintenance_work_mem');
    } catch (resetError) {
      const resetMessage = resetError instanceof Error ? resetError.message : String(resetError);
      logger.error('Failed to reset maintenance_work_mem after HNSW index build', {
        dimension,
        error: resetMessage,
      });
      // A successful build with a failed RESET must NOT resolve: the raised
      // limit would silently ride along in every subsequent query's session
      // while the caller records a healthy rebuild. When the build itself
      // failed, the original build error propagates below (the reset failure
      // is logged here) — masking the root cause would misdirect retries.
      if (!buildFailed) {
        throw new Error(
          `Failed to reset maintenance_work_mem after HNSW index build for ${dimension}D: ${resetMessage}`
        );
      }
    }
  }

  if (buildFailed) {
    throw buildError;
  }
}

const DIMENSION_INDEX_SUSPENSIONS_TABLE = 'embedding_dimension_index_suspensions';

/**
 * Read HNSW tuning parameters from environment variables.
 * @returns HNSW index configuration parameters
 */
export function hnswParams(): HnswParams {
  const envObj = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;

  const m = Number(envObj?.['HNSW_M'] ?? '16');
  const ef = Number(envObj?.['HNSW_EF_CONSTRUCTION'] ?? '64');

  return {
    ef: Number.isFinite(ef) && ef > 0 ? Math.floor(ef) : 64,
    m: Number.isFinite(m) && m > 0 ? Math.floor(m) : 16,
  };
}

/**
 * Generate consistent index name for a dimension.
 * @param dimension - The embedding dimension
 * @returns Index name string
 */
function indexName(dimension: number): string {
  return `idx_file_chunks_emb_hnsw_${dimension}`;
}

/**
 * Create an HNSW index for a specific embedding dimension.
 * Uses partial indexing with expression casting to support dimensionless VECTOR column.
 *
 * SECURITY: All parameters are validated before SQL interpolation to prevent injection.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension to index (must be positive integer <= 65535)
 * @param params - HNSW tuning parameters (m, ef_construction) - must be positive integers
 */
export async function createDimensionIndex(
  db: DimensionIndexDb,
  dimension: number,
  params: HnswParams
): Promise<void> {
  // CRITICAL: Validate all interpolated values before SQL construction
  // This prevents SQL injection even if callers pass malicious input
  validateDimensionForSql(dimension, 'createDimensionIndex');
  validateHnswParamsForSql(params, 'createDimensionIndex');

  // pgvector's halfvec HNSW index supports up to 4000 dimensions (MAX_HNSW_DIMENSION).
  // Vectors with more dimensions can still be stored and queried via sequential scan.
  if (dimension > MAX_HNSW_DIMENSION) {
    logger.warn(
      `Skipping HNSW index creation for ${dimension}D vectors: ` +
        `pgvector HNSW limit is ${MAX_HNSW_DIMENSION}. ` +
        'Queries will use sequential scan (slower for large datasets).'
    );
    return;
  }

  const name = indexName(dimension);

  // Validate index name format as additional defense-in-depth
  // This ensures the name matches expected format: idx_file_chunks_emb_hnsw_<digits>
  if (!/^idx_file_chunks_emb_hnsw_\d+$/.test(name)) {
    throw new Error(`createDimensionIndex: Invalid index name format: ${name}`);
  }

  // Use a half-precision (halfvec) expression cast + partial index on vector_dims().
  // halfvec halves the on-disk HNSW index and speeds builds/search for a tiny
  // recall cost; it also raises pgvector's HNSW dimension ceiling from 2000 to
  // 4000, so large models (e.g. 3072-dim) get an ANN index instead of a seq scan.
  // The full-precision vector stays in the column; only the index/ranking is fp16.
  // The query planner uses this index when the ORDER BY casts to halfvec(N) too.
  // SECURITY: dimension and params are validated integers above, safe for SQL interpolation
  const sqlStatement = `
    CREATE INDEX IF NOT EXISTS ${name} ON file_chunks
    USING hnsw ((embedding::halfvec(${dimension})) halfvec_cosine_ops)
    WITH (m=${params.m}, ef_construction=${params.ef})
    WHERE vector_dims(embedding) = ${dimension}
  `;

  // A graph larger than maintenance_work_mem forces pgvector's slow disk-based
  // build phase (benchmarked 5x slower at 100k chunks x 1024 dims — see
  // MAX_INDEX_BUILD_MAINTENANCE_WORK_MEM_MB). withIndexBuildMaintenanceWorkMem
  // raises the setting for the build only and always resets it afterwards.
  try {
    await withIndexBuildMaintenanceWorkMem(db, dimension, async () => {
      await db.exec(sqlStatement);
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Ignore "already exists" errors for idempotency
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to create HNSW index for ${dimension}D: ${msg}`);
    }
  }
}

/**
 * Drop an HNSW index for a specific dimension.
 *
 * SECURITY: Dimension is validated before SQL interpolation to prevent injection.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension whose index to drop (must be positive integer <= 65535)
 */
export async function dropDimensionIndex(
  db: Pick<DimensionIndexDb, 'exec'>,
  dimension: number
): Promise<void> {
  // Validate dimension to prevent SQL injection via index name
  validateDimensionForSql(dimension, 'dropDimensionIndex');

  const name = indexName(dimension);

  // Validate index name format as additional defense-in-depth
  if (!/^idx_file_chunks_emb_hnsw_\d+$/.test(name)) {
    throw new Error(`dropDimensionIndex: Invalid index name format: ${name}`);
  }

  try {
    await db.exec(`DROP INDEX IF EXISTS ${name}`);
  } catch {
    // Ignore errors on drop - best effort cleanup
  }
}

/**
 * Get all distinct dimensions currently in use by embedding sets.
 *
 * @param db - PGlite database instance
 * @returns Array of distinct dimension values
 */
export async function getDistinctDimensions(
  db: Pick<DimensionIndexDb, 'query'>
): Promise<number[]> {
  const result = await db.query<{ dimensions: number }>(
    'SELECT DISTINCT dimensions FROM embedding_sets WHERE dimensions IS NOT NULL ORDER BY dimensions'
  );
  return result.rows.map((row) => row.dimensions);
}

/**
 * Ensure an HNSW index exists for a given dimension.
 * This is idempotent - safe to call multiple times.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension to ensure index for
 */
export async function ensureDimensionIndexExists(
  db: DimensionIndexDb,
  dimension: number
): Promise<void> {
  const params = hnswParams();
  await createDimensionIndex(db, dimension, params);
}

export async function suspendDimensionIndexBuilds(
  db: Pick<DimensionIndexDb, 'query'>,
  dimension: number,
  reason: string,
  suspendedAt: string
): Promise<void> {
  validateDimensionForSql(dimension, 'suspendDimensionIndexBuilds');
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('suspendDimensionIndexBuilds requires a non-empty reason.');
  }
  if (typeof suspendedAt !== 'string' || suspendedAt.trim().length === 0) {
    throw new Error('suspendDimensionIndexBuilds requires a non-empty suspendedAt timestamp.');
  }
  await db.query(
    `INSERT INTO ${DIMENSION_INDEX_SUSPENSIONS_TABLE} (dimension, reason, suspended_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (dimension) DO UPDATE
       SET reason = EXCLUDED.reason,
           suspended_at = EXCLUDED.suspended_at`,
    [dimension, reason, suspendedAt]
  );
}

export async function resumeDimensionIndexBuilds(
  db: Pick<DimensionIndexDb, 'query'>,
  dimension: number
): Promise<void> {
  validateDimensionForSql(dimension, 'resumeDimensionIndexBuilds');
  await db.query(`DELETE FROM ${DIMENSION_INDEX_SUSPENSIONS_TABLE} WHERE dimension = $1`, [
    dimension,
  ]);
}

export async function isDimensionIndexBuildSuspended(
  db: Pick<DimensionIndexDb, 'query'>,
  dimension: number
): Promise<boolean> {
  validateDimensionForSql(dimension, 'isDimensionIndexBuildSuspended');
  try {
    const result = await db.query<{ count: number | string | null }>(
      `SELECT COUNT(*)::int AS count
         FROM ${DIMENSION_INDEX_SUSPENSIONS_TABLE}
        WHERE dimension = $1`,
      [dimension]
    );
    return Number(result.rows[0]?.count ?? 0) > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(DIMENSION_INDEX_SUSPENSIONS_TABLE)) {
      return false;
    }
    throw error;
  }
}

export interface DeferredDimensionIndexBuilder {
  /**
   * Kick off a best-effort HNSW index build for `dimension` WITHOUT blocking the
   * caller. Returns immediately and never throws. Deduplicates by dimension: a
   * second call while a build is in flight is a no-op.
   */
  schedule(dimension: number): void;
  /**
   * Await the builds in flight AT CALL TIME (snapshot semantics — a build
   * scheduled after this call is not awaited). Never rejects (best-effort).
   */
  whenSettled(): Promise<void>;
}

/**
 * Delay before a scheduled build dispatches its CREATE INDEX. PGlite runs on a
 * single connection, so dispatching in the same turn as `schedule()` would queue
 * the caller's own follow-up queries (create set → immediately search/open the
 * collection) behind an index build that takes seconds on small tables and
 * MINUTES at scale (measured 2026-07-11: ~8.5 min at 100k chunks x 1024 dims
 * with the tuned maintenance_work_mem, ~42 min untuned at the 64MB default).
 * This window lets that flow — including its IPC round trips on desktop —
 * reach the connection first; the build is idempotent, so the late start is
 * free.
 */
export const DIMENSION_INDEX_BUILD_START_DELAY_MS = 250;

/**
 * Per-session cap on build attempts per dimension. Read-path re-arms (getById)
 * fire on every status poll, so a persistently-failing build (HNSW OOM, driver
 * error) must not become a sustained loop of connection-blocking CREATE INDEX
 * attempts (seconds on small tables, minutes at 100k-chunk scale). Transient
 * failures still get retries below the cap; a fresh session resets the count.
 */
export const MAX_DIMENSION_INDEX_BUILD_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Creates a deferred, deduplicated HNSW-index builder.
 *
 * A `CREATE INDEX ... USING hnsw` on a populated `file_chunks` table takes
 * seconds on small tables and minutes at scale (measured 2026-07-11: 505s at
 * 100k chunks x 1024 dims with maintenance_work_mem tuned to 512MB, 2,496s at
 * the 64MB default) and, on PGlite's single connection, blocks every other
 * query while it runs. Awaiting it inline during embedding-set creation froze the foreground
 * flow. This builder decouples the build from the caller: embedding-set creation
 * returns immediately and search degrades gracefully to a sequential scan until
 * the index lands. The build is idempotent (`CREATE INDEX IF NOT EXISTS`), so a
 * build lost to shutdown self-heals on the next `getOrCreate*` call.
 *
 * `getDb`/`onError` are read lazily so the builder can be constructed as a field
 * initializer before the owning repository's `db`/`logger` are assigned.
 */
export function createDeferredDimensionIndexBuilder(options: {
  getDb: () => DimensionIndexDb;
  onError: (dimension: number, error: unknown) => void;
}): DeferredDimensionIndexBuilder {
  const pending = new Map<number, Promise<void>>();
  // Dimensions that built successfully this session. Read-path re-arms (e.g.
  // getById) call schedule() on every access; without this memo each call would
  // dispatch a CREATE INDEX IF NOT EXISTS round-trip onto the single
  // connection. A FAILED build is retried on later schedules — but only up to
  // MAX_DIMENSION_INDEX_BUILD_ATTEMPTS per session, so a persistently-failing
  // build can't turn polled reads into a connection-blocking retry storm.
  const completed = new Set<number>();
  const failureCounts = new Map<number, number>();
  // Builds SERIALIZE across dimensions. maintenance_work_mem is session-global
  // on PGlite's single connection: with concurrent per-dimension builds, build
  // A's finally-RESET could land between build B's SET and B's CREATE INDEX,
  // silently running B at the 64MB default (the slow spilling build this
  // tuning exists to avoid). The connection can only execute one CREATE INDEX
  // at a time anyway, so chaining costs nothing.
  let buildChain: Promise<void> = Promise.resolve();
  return {
    schedule(dimension: number): void {
      if (
        completed.has(dimension) ||
        pending.has(dimension) ||
        (failureCounts.get(dimension) ?? 0) >= MAX_DIMENSION_INDEX_BUILD_ATTEMPTS
      ) {
        return;
      }
      const previousBuild = buildChain;
      const build = (async () => {
        // Never rejects: every build settles through its own catch below.
        await previousBuild;
        try {
          // Yield the single connection to the scheduling flow's own follow-up
          // queries before dispatching the long CREATE INDEX.
          await delay(DIMENSION_INDEX_BUILD_START_DELAY_MS);
          if (await isDimensionIndexBuildSuspended(options.getDb(), dimension)) {
            return;
          }
          await ensureDimensionIndexExists(options.getDb(), dimension);
          completed.add(dimension);
        } catch (error) {
          failureCounts.set(dimension, (failureCounts.get(dimension) ?? 0) + 1);
          options.onError(dimension, error);
        } finally {
          pending.delete(dimension);
        }
      })();
      buildChain = build;
      pending.set(dimension, build);
    },
    async whenSettled(): Promise<void> {
      await Promise.allSettled([...pending.values()]);
    },
  };
}

/**
 * Check if an HNSW index exists for a given dimension.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension to check
 * @returns true if index exists
 */
export async function dimensionIndexExists(
  db: Pick<DimensionIndexDb, 'query'>,
  dimension: number
): Promise<boolean> {
  const name = indexName(dimension);
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text as count FROM pg_indexes WHERE indexname = $1',
    [name]
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

/**
 * Drop all dimension-based HNSW indexes.
 * Useful for cleanup during migration rollback.
 *
 * @param db - PGlite database instance
 * @param dimensions - Array of dimensions whose indexes to drop
 */
export async function dropAllDimensionIndexes(
  db: Pick<DimensionIndexDb, 'exec'>,
  dimensions: number[]
): Promise<void> {
  for (const dim of dimensions) {
    await dropDimensionIndex(db, dim);
  }
}
