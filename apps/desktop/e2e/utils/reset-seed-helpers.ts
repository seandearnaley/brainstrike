import type { Page } from '@playwright/test';

/**
 * Row counts for the three relations a Clear Database / factory reset must empty.
 *
 * `workflowSnapshots` is the BST-558 invariant: `mastra_workflow_snapshot` is
 * created lazily by `PgliteWorkflowsStore.initialize()` and by NO migration, so
 * these helpers create it explicitly rather than assuming the assistant has run.
 */
export interface ResetProbeCounts {
  readonly fileChunks: number;
  readonly fileRecords: number;
  readonly workflowSnapshots: number;
}

/**
 * Establishes the probe state unconditionally: one `file_records` row, one
 * `file_chunks` child, and one `mastra_workflow_snapshot` row behind an
 * idempotent CREATE.
 *
 * Ids are bare `crypto.randomUUID()` values because they are collision-free and
 * valid in the `text` primary keys `file_records.id` / `file_chunks.id`.
 *
 * Deliberately NOT probe-and-adapt: a seed that silently accepts either schema
 * state cannot report which branch the test exercised.
 */
export async function seedResetProbeRows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as { db?: { query?: (sql: string, params?: readonly unknown[]) => Promise<unknown> } }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }

    const fileRecordId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    await query('INSERT INTO file_records (id, name, path, size) VALUES ($1, $2, $3, $4)', [
      fileRecordId,
      'reset-probe.txt',
      `reset-probe://${fileRecordId}`,
      42,
    ]);
    await query(
      'INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, $3)',
      [chunkId, fileRecordId, 'reset probe chunk']
    );

    // `db:query` permits CREATE TABLE (only DROP/TRUNCATE/ALTER..DROP are
    // rejected) and is single-statement, so the indexes from
    // MASTRA_WORKFLOW_SCHEMA_SQL are intentionally omitted — this test only
    // needs the relation to exist and hold a row.
    await query(
      `CREATE TABLE IF NOT EXISTS mastra_workflow_snapshot (
         workflow_name TEXT NOT NULL,
         run_id TEXT NOT NULL,
         "resourceId" TEXT,
         snapshot JSONB NOT NULL,
         "createdAt" TIMESTAMPTZ NOT NULL,
         "updatedAt" TIMESTAMPTZ NOT NULL,
         PRIMARY KEY (workflow_name, run_id)
       )`
    );
    await query(
      `INSERT INTO mastra_workflow_snapshot
         (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
      ['reset-probe-workflow', runId, 'reset-probe-resource', '{"status":"suspended"}']
    );
  });
}

/** Reads the three probe counts. Throws if the bridge or a relation is missing. */
export async function readResetProbeCounts(page: Page): Promise<ResetProbeCounts> {
  return await page.evaluate(async () => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as {
        db?: {
          query?: (sql: string) => Promise<{ rows?: readonly Record<string, unknown>[] }>;
        };
      }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }

    const countOf = async (table: string): Promise<number> => {
      const result = await query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      const value = result?.rows?.[0]?.['count'];
      if (typeof value !== 'number') {
        throw new Error(`Count for ${table} was not a number: ${JSON.stringify(value)}`);
      }
      return value;
    };

    return {
      fileChunks: await countOf('file_chunks'),
      fileRecords: await countOf('file_records'),
      workflowSnapshots: await countOf('mastra_workflow_snapshot'),
    };
  });
}
