/**
 * @module pipeline/schema-health
 *
 * Schema health checking, corruption detection, and recovery utilities.
 *
 * This module provides tools for monitoring the health of pipeline-related
 * database tables and recovering from corrupted or inconsistent states.
 *
 * ## Pipeline Tables
 *
 * The pipeline depends on these core tables:
 * - `file_records` - Source files being indexed
 * - `file_chunks` - Chunked content from files
 * - `embedding_sets` - Embedding collection configurations
 * - `job_queue` - Durable job queue for embedding tasks
 *
 * ## Corruption Scenarios
 *
 * Common corruption patterns this module detects:
 * 1. **Orphaned chunks** - Chunks referencing deleted files
 * 2. **Stuck jobs** - Jobs in 'running' state with expired leases
 * 3. **Missing references** - Chunks referencing non-existent embedding sets
 * 4. **Schema drift** - Tables missing expected columns
 *
 * @example
 * ```typescript
 * const checker = createSchemaHealthChecker(db);
 *
 * // Check overall health
 * const health = await checker.checkHealth();
 * if (!health.healthy) {
 *   console.log('Issues:', health.issues);
 * }
 *
 * // Recover from stuck jobs
 * const recovered = await checker.recoverStuckJobs(60_000);
 * console.log(`Recovered ${recovered} stuck jobs`);
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Database interface required for health checking.
 * Minimal subset of PGlite interface.
 */
export interface HealthCheckDb {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

/**
 * Result of checking a single table's health.
 */
export interface TableHealthResult {
  /** Whether the table exists */
  exists: boolean;
  /** Any issues detected */
  issues: string[];
  /** Row count if table exists */
  rowCount?: number;
  /** Table name */
  table: string;
}

/**
 * Overall pipeline schema health summary.
 */
export interface SchemaHealthSummary {
  /** Timestamp of the health check */
  checkedAt: string;
  /** Corruption metrics */
  corruption: CorruptionMetrics;
  /** Whether the schema is healthy overall */
  healthy: boolean;
  /** Aggregated list of all issues */
  issues: string[];
  /** Individual table results */
  tables: TableHealthResult[];
}

/**
 * Metrics about potential corruption.
 */
export interface CorruptionMetrics {
  /** Chunks referencing non-existent embedding sets */
  invalidEmbeddingSetRefs: number;
  /** Jobs with invalid or unparseable payloads */
  invalidJobPayloads: number;
  /** Chunks without valid file_record references */
  orphanedChunks: number;
  /** Jobs stuck in 'running' state past lease expiry */
  stuckJobs: number;
}

/**
 * Result of a recovery operation.
 */
export interface RecoveryResult {
  /** Error message if recovery failed */
  error?: string;
  /** Number of items recovered/cleaned */
  recoveredCount: number;
  /** Whether recovery succeeded */
  success: boolean;
}

/**
 * Schema health checker interface.
 */
export interface SchemaHealthChecker {
  /**
   * Cancel all running and queued jobs.
   * Useful for recovery when worker state is lost.
   * @returns Number of jobs canceled
   */
  cancelAllPendingJobs: () => Promise<RecoveryResult>;

  /**
   * Check overall schema health including corruption detection.
   */
  checkHealth: () => Promise<SchemaHealthSummary>;
  /**
   * Check if all required pipeline tables exist.
   */
  checkTablesExist: () => Promise<TableHealthResult[]>;

  /**
   * Delete orphaned chunks.
   * @returns Number of chunks deleted
   */
  cleanOrphanedChunks: () => Promise<RecoveryResult>;

  /**
   * Clear all embedding-related data for a full reindex.
   * Clears: file_chunks, job_queue (embed jobs), resets file_records embedding fields.
   * @returns Recovery result with counts
   */
  clearForReindex: () => Promise<RecoveryResult>;

  /**
   * Count chunks referencing non-existent embedding sets.
   */
  countInvalidEmbeddingSetRefs: () => Promise<number>;

  /**
   * Count orphaned chunks (chunks without valid file records).
   */
  countOrphanedChunks: () => Promise<number>;

  /**
   * Count stuck jobs (jobs past their lease expiry but still 'running').
   * @param leaseTimeoutMs - Consider jobs stuck after this many ms (default: 5 minutes)
   */
  countStuckJobs: (leaseTimeoutMs?: number) => Promise<number>;

  /**
   * Reset stuck jobs back to 'queued' state.
   * @param leaseTimeoutMs - Consider jobs stuck after this many ms
   * @returns Number of jobs recovered
   */
  recoverStuckJobs: (leaseTimeoutMs?: number) => Promise<RecoveryResult>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Tables required for pipeline operations */
const PIPELINE_TABLES = ['file_records', 'file_chunks', 'embedding_sets', 'job_queue'] as const;

/** Default lease timeout for stuck job detection (5 minutes) */
const DEFAULT_LEASE_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a schema health checker instance.
 *
 * @param db - Database connection with query capability
 * @returns Schema health checker
 */
export function createSchemaHealthChecker(db: HealthCheckDb): SchemaHealthChecker {
  // ---------------------------------------------------------------------------
  // Table Existence Check
  // ---------------------------------------------------------------------------

  async function checkTablesExist(): Promise<TableHealthResult[]> {
    const results: TableHealthResult[] = [];

    for (const table of PIPELINE_TABLES) {
      const result = await checkSingleTable(table);
      results.push(result);
    }

    return results;
  }

  async function checkSingleTable(table: string): Promise<TableHealthResult> {
    try {
      // Check if table exists via information_schema
      const existsResult = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        ) as exists`,
        [table]
      );

      const exists = existsResult.rows[0]?.exists ?? false;

      if (!exists) {
        return {
          exists: false,
          issues: [`Table '${table}' does not exist`],
          table,
        };
      }

      // Get row count for existing tables
      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM "${table}"`
      );
      const rowCount = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);

      return {
        exists: true,
        issues: [],
        rowCount,
        table,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exists: false,
        issues: [`Failed to check table '${table}': ${message}`],
        table,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Corruption Detection
  // ---------------------------------------------------------------------------

  async function countOrphanedChunks(): Promise<number> {
    try {
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*)::text as count
        FROM file_chunks fc
        LEFT JOIN file_records fr ON fc.file_record_id = fr.id
        WHERE fr.id IS NULL
      `);
      return Number.parseInt(result.rows[0]?.count ?? '0', 10);
    } catch {
      // Table may not exist
      return 0;
    }
  }

  async function countStuckJobs(leaseTimeoutMs = DEFAULT_LEASE_TIMEOUT_MS): Promise<number> {
    try {
      const result = await db.query<{ count: string }>(
        `
        SELECT COUNT(*)::text as count
        FROM job_queue
        WHERE state = 'running'
          AND leased_until IS NOT NULL
          AND leased_until < NOW() - INTERVAL '1 millisecond' * $1
      `,
        [leaseTimeoutMs]
      );
      return Number.parseInt(result.rows[0]?.count ?? '0', 10);
    } catch {
      return 0;
    }
  }

  async function countInvalidEmbeddingSetRefs(): Promise<number> {
    try {
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*)::text as count
        FROM file_chunks fc
        WHERE fc.embedding_set_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM embedding_sets es WHERE es.id = fc.embedding_set_id
          )
      `);
      return Number.parseInt(result.rows[0]?.count ?? '0', 10);
    } catch {
      return 0;
    }
  }

  async function countInvalidJobPayloads(): Promise<number> {
    try {
      // Check for jobs where payload is not valid JSON
      const result = await db.query<{ count: string }>(`
        SELECT COUNT(*)::text as count
        FROM job_queue
        WHERE payload IS NOT NULL
          AND payload != ''
          AND (
            payload NOT LIKE '{%'
            OR payload NOT LIKE '%}'
          )
      `);
      return Number.parseInt(result.rows[0]?.count ?? '0', 10);
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  async function checkHealth(): Promise<SchemaHealthSummary> {
    const tables = await checkTablesExist();
    const allIssues: string[] = [];

    // Collect table issues
    for (const table of tables) {
      allIssues.push(...table.issues);
    }

    // Check corruption metrics
    // biome-ignore assist/source/useSortedKeys: these awaited checks have observable query order in tests and diagnostics.
    const corruption: CorruptionMetrics = {
      orphanedChunks: await countOrphanedChunks(),
      stuckJobs: await countStuckJobs(),
      invalidEmbeddingSetRefs: await countInvalidEmbeddingSetRefs(),
      invalidJobPayloads: await countInvalidJobPayloads(),
    };

    // Add corruption-related issues
    if (corruption.orphanedChunks > 0) {
      allIssues.push(`Found ${corruption.orphanedChunks} orphaned chunks without file records`);
    }
    if (corruption.stuckJobs > 0) {
      allIssues.push(`Found ${corruption.stuckJobs} stuck jobs past lease expiry`);
    }
    if (corruption.invalidEmbeddingSetRefs > 0) {
      allIssues.push(
        `Found ${corruption.invalidEmbeddingSetRefs} chunks referencing invalid embedding sets`
      );
    }
    if (corruption.invalidJobPayloads > 0) {
      allIssues.push(`Found ${corruption.invalidJobPayloads} jobs with invalid payloads`);
    }

    const allTablesExist = tables.every((t) => t.exists);
    const noCorruption = Object.values(corruption).every((v) => v === 0);

    return {
      checkedAt: new Date().toISOString(),
      corruption,
      healthy: allTablesExist && noCorruption,
      issues: allIssues,
      tables,
    };
  }

  // ---------------------------------------------------------------------------
  // Recovery Operations
  // ---------------------------------------------------------------------------

  async function cleanOrphanedChunks(): Promise<RecoveryResult> {
    try {
      const result = await db.query<{ count: string }>(`
        WITH deleted AS (
          DELETE FROM file_chunks fc
          WHERE NOT EXISTS (
            SELECT 1 FROM file_records fr WHERE fr.id = fc.file_record_id
          )
          RETURNING 1
        )
        SELECT COUNT(*)::text as count FROM deleted
      `);
      const count = Number.parseInt(result.rows[0]?.count ?? '0', 10);
      return { recoveredCount: count, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, recoveredCount: 0, success: false };
    }
  }

  async function recoverStuckJobs(
    leaseTimeoutMs = DEFAULT_LEASE_TIMEOUT_MS
  ): Promise<RecoveryResult> {
    try {
      const result = await db.query<{ count: string }>(
        `
        WITH recovered AS (
          UPDATE job_queue
          SET
            state = 'queued',
            lease_token = NULL,
            leased_until = NULL,
            worker_id = NULL,
            updated_at = NOW()
          WHERE state = 'running'
            AND leased_until IS NOT NULL
            AND leased_until < NOW() - INTERVAL '1 millisecond' * $1
          RETURNING 1
        )
        SELECT COUNT(*)::text as count FROM recovered
      `,
        [leaseTimeoutMs]
      );
      const count = Number.parseInt(result.rows[0]?.count ?? '0', 10);
      return { recoveredCount: count, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, recoveredCount: 0, success: false };
    }
  }

  async function cancelAllPendingJobs(): Promise<RecoveryResult> {
    try {
      // The metrics CTE mirrors incrementOutcomeMetricsCte in @brainstrike/db
      // (packages/db/src/queue/job-queue.ts) — pipeline cannot depend on that
      // package, so keep the SQL shape in sync by hand. Folding the lifetime
      // canceled counter into the same statement as the transition keeps the
      // aggregate-then-prune invariant: a job can never reach 'canceled'
      // without being counted.
      const result = await db.query<{ count: string }>(`
        WITH canceled AS (
          UPDATE job_queue
          SET
            state = 'canceled',
            lease_token = NULL,
            leased_until = NULL,
            worker_id = NULL,
            updated_at = NOW()
          WHERE state IN ('queued', 'running')
          RETURNING queue
        ),
        metrics AS (
          INSERT INTO job_queue_metrics (queue, canceled_total)
          SELECT queue, COUNT(*) FROM canceled GROUP BY queue
          ON CONFLICT (queue) DO UPDATE
            SET canceled_total = job_queue_metrics.canceled_total + EXCLUDED.canceled_total
        )
        SELECT COUNT(*)::text as count FROM canceled
      `);
      const count = Number.parseInt(result.rows[0]?.count ?? '0', 10);
      return { recoveredCount: count, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, recoveredCount: 0, success: false };
    }
  }

  async function clearForReindex(): Promise<RecoveryResult> {
    try {
      let totalCleared = 0;

      // 1. Delete all file chunks (embeddings will be regenerated)
      const chunksResult = await db.query<{ count: string }>(`
        WITH deleted AS (
          DELETE FROM file_chunks
          RETURNING 1
        )
        SELECT COUNT(*)::text as count FROM deleted
      `);
      totalCleared += Number.parseInt(chunksResult.rows[0]?.count ?? '0', 10);

      // 2. Cancel/delete all embedding jobs
      const jobsResult = await db.query<{ count: string }>(`
        WITH deleted AS (
          DELETE FROM job_queue
          WHERE job_type = 'embed_chunk'
          RETURNING 1
        )
        SELECT COUNT(*)::text as count FROM deleted
      `);
      totalCleared += Number.parseInt(jobsResult.rows[0]?.count ?? '0', 10);

      // 3. Reset file_records embedding-related fields
      await db.query(`
        UPDATE file_records
        SET
          chunks_processed_at = NULL,
          chunks_count = NULL,
          chunking_strategy = NULL
      `);

      return { recoveredCount: totalCleared, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, recoveredCount: 0, success: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Return Public API
  // ---------------------------------------------------------------------------

  return {
    cancelAllPendingJobs,
    checkHealth,
    checkTablesExist,
    cleanOrphanedChunks,
    clearForReindex,
    countInvalidEmbeddingSetRefs,
    countOrphanedChunks,
    countStuckJobs,
    recoverStuckJobs,
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if a health summary indicates the schema is ready for pipeline operations.
 *
 * @param summary - Health summary to check
 * @returns true if schema is ready
 */
export function isSchemaReady(summary: SchemaHealthSummary): boolean {
  // All required tables must exist
  return summary.tables.every((t) => t.exists);
}

/**
 * Check if a health summary has recoverable issues.
 * Recoverable issues can be fixed without user intervention.
 *
 * @param summary - Health summary to check
 * @returns true if there are recoverable issues
 */
export function hasRecoverableIssues(summary: SchemaHealthSummary): boolean {
  const { corruption } = summary;
  return corruption.orphanedChunks > 0 || corruption.stuckJobs > 0;
}

/**
 * Get a human-readable health status string.
 *
 * @param summary - Health summary
 * @returns Status string
 */
export function formatHealthStatus(summary: SchemaHealthSummary): string {
  if (summary.healthy) {
    return 'Schema is healthy';
  }

  const parts: string[] = [];

  const missingTables = summary.tables.filter((t) => !t.exists).map((t) => t.table);
  if (missingTables.length > 0) {
    parts.push(`Missing tables: ${missingTables.join(', ')}`);
  }

  const { corruption } = summary;
  if (corruption.orphanedChunks > 0) {
    parts.push(`${corruption.orphanedChunks} orphaned chunks`);
  }
  if (corruption.stuckJobs > 0) {
    parts.push(`${corruption.stuckJobs} stuck jobs`);
  }
  if (corruption.invalidEmbeddingSetRefs > 0) {
    parts.push(`${corruption.invalidEmbeddingSetRefs} invalid embedding refs`);
  }

  return parts.length > 0 ? parts.join('; ') : 'Unknown issues';
}

/**
 * Get recommended recovery actions based on health summary.
 *
 * @param summary - Health summary
 * @returns Array of recommended action descriptions
 */
export function getRecommendedActions(
  summary: SchemaHealthSummary
): Array<{ action: string; description: string }> {
  const actions: Array<{ action: string; description: string }> = [];

  const missingTables = summary.tables.filter((t) => !t.exists);
  if (missingTables.length > 0) {
    actions.push({
      action: 'runMigrations',
      description: 'Run database migrations to create missing tables',
    });
  }

  if (summary.corruption.stuckJobs > 0) {
    actions.push({
      action: 'recoverStuckJobs',
      description: `Recover ${summary.corruption.stuckJobs} stuck jobs back to queued state`,
    });
  }

  if (summary.corruption.orphanedChunks > 0) {
    actions.push({
      action: 'cleanOrphanedChunks',
      description: `Delete ${summary.corruption.orphanedChunks} orphaned chunks`,
    });
  }

  if (summary.corruption.invalidEmbeddingSetRefs > 0) {
    actions.push({
      action: 'clearForReindex',
      description: 'Clear all chunks and reindex to fix invalid embedding set references',
    });
  }

  return actions;
}
