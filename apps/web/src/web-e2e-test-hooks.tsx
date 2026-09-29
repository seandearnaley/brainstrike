import { usePGliteDatabase } from '@brainstrike/db/react';
import { useEffect } from 'react';
import type { WebE2EEmbeddingModelSwitchMemoryProbeResult } from './embedding-model-switch-memory-probe-contract';
import { BST369_E2E_INIT_FLAG } from './embedding-model-switch-memory-probe-contract';
import { qualifyLocalEmbedding } from './qualify-local-embedding';

interface ModelEnabledRow {
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  readonly is_enabled: boolean | number | string | null;
}

interface AssistantThreadRow {
  readonly id: string;
  readonly metadata: unknown;
  readonly resourceId: string;
  readonly title: string | null;
}

interface AssistantThreadRunRow {
  readonly id: string;
}

interface AssistantThreadRunStatusRow {
  readonly status: string;
}

interface ExtensionRow {
  readonly extname: string;
}

interface SearchQualificationRow {
  readonly distance: number | string;
  // biome-ignore lint/style/useNamingConvention: SQL projection uses snake_case
  readonly full_text_match: boolean | number | string | null;
}

interface Bm25QualificationRow {
  // biome-ignore lint/style/useNamingConvention: SQL projection uses snake_case
  readonly bm25_score: number | string;
}

export interface WebE2EAssistantThreadSnapshot {
  readonly id: string;
  readonly metadata: unknown;
  readonly resourceId: string;
  readonly title: string;
}

export interface WebE2EAssistantThreadRunInput {
  readonly id: string;
  readonly resourceId: string;
  readonly startedAt?: string;
  readonly threadId: string;
}

export interface WebE2EDatabaseQualification {
  readonly bm25Score: number;
  readonly extensions: readonly string[];
  readonly fullTextMatch: boolean;
  readonly vectorDistance: number;
}

export interface WebE2EEmbeddingQualification {
  readonly device: string;
  readonly dimensions: number;
  readonly dtype: string;
  readonly fallbackApplied: boolean;
  readonly finite: boolean;
}

export interface WebE2EResetRowCounts {
  readonly fileChunks: number;
  readonly fileRecords: number;
  readonly workflowSnapshots: number;
}

/**
 * Narrower sibling of `WebE2EResetRowCounts` that omits `mastra_workflow_snapshot`.
 * `readResetRowCounts` throws when that relation is absent (by design — see its
 * implementation below), so a caller that needs to observe `file_records`/
 * `file_chunks` counts on a profile that deliberately never created the
 * relation (the BST-558 absent-relation regression path) needs a count that
 * cannot itself raise 42P01.
 */
export interface WebE2EFileRowCounts {
  readonly fileChunks: number;
  readonly fileRecords: number;
}

interface CountRow {
  readonly count: number | string;
}

export interface WebE2ETestHooks {
  readonly completeAssistantThreadRun: (
    runId: string,
    status: 'cancelled' | 'completed' | 'failed'
  ) => Promise<void>;
  readonly createAssistantThreadRun: (input: WebE2EAssistantThreadRunInput) => Promise<void>;
  readonly dbPath: string;
  /**
   * Links the `reset-probe://` file record and `reset probe chunk` chunk
   * (seeded by `seedResetProbeRows` or `seedFileRowsOnly`) to a real
   * collection. `ClearDatabaseDialog`'s trigger button is disabled unless the
   * ACTIVE collection reports non-zero live counts
   * (`ACTIVE_COLLECTION_LIVE_COUNTS_QUERY`), so without this the button never
   * enables on a fresh profile with zero collections and the real UI path
   * can't be exercised end to end.
   */
  readonly linkResetProbeRowsToCollection: (collectionId: string) => Promise<void>;
  readonly qualifyDatabaseExtensions: () => Promise<WebE2EDatabaseQualification>;
  readonly qualifyLocalEmbedding: (
    deviceHint?: 'wasm' | 'webgpu'
  ) => Promise<WebE2EEmbeddingQualification>;
  readonly readAssistantThreadRunStatuses: (threadId: string) => Promise<readonly string[]>;
  readonly readAssistantThreads: () => Promise<readonly WebE2EAssistantThreadSnapshot[]>;
  readonly readFileRowCounts: () => Promise<WebE2EFileRowCounts>;
  readonly readModelEnabled: (modelId: string) => Promise<boolean | null>;
  readonly readResetRowCounts: () => Promise<WebE2EResetRowCounts>;
  readonly runEmbeddingModelSwitchMemoryProbe?: () => Promise<WebE2EEmbeddingModelSwitchMemoryProbeResult>;
  /**
   * Seeds ONLY `file_records` + `file_chunks` — deliberately does NOT create
   * `mastra_workflow_snapshot` (contrast `seedResetProbeRows`). Used to prove
   * the absent-relation path: a fresh web profile never boots Mastra memory,
   * so the relation genuinely does not exist until something creates it.
   */
  readonly seedFileRowsOnly: () => Promise<void>;
  readonly seedResetProbeRows: () => Promise<void>;
  readonly syncDatabase: () => Promise<void>;
}

declare global {
  interface Window {
    __brainstrikeEnableEmbeddingModelSwitchMemoryProbe__?: true;
    __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks;
  }
}

async function runEmbeddingModelSwitchMemoryProbe(): Promise<WebE2EEmbeddingModelSwitchMemoryProbeResult> {
  if (window.navigator.webdriver !== true) {
    throw new Error('Embedding model-switch memory probe is restricted to webdriver automation.');
  }
  if (Reflect.get(window, BST369_E2E_INIT_FLAG) !== true) {
    throw new Error('Embedding model-switch memory probe requires the explicit init-script flag.');
  }
  const probe = await import('./embedding-model-switch-memory-probe');
  return probe.runEmbeddingModelSwitchMemoryProbe();
}

function parseModelEnabled(value: ModelEnabledRow['is_enabled']): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * PGlite does NOT populate `affectedRows` on a `tx.query()` result taken
 * inside a transaction — the raw result comes back as `{ rows: [] }` with no
 * such key, so a row-count assertion built on `affectedRows` can never see a
 * match and always throws, even when the UPDATE succeeded. `RETURNING id` is
 * the mechanism PGlite actually supports: the matched rows land in
 * `result.rows`, so `rows.length` is the real, always-populated signal.
 * `QueryExecutor['query']` (packages/db/src/db-provider.tsx) only types its
 * return as `{ rows: T[] }`; read it through `unknown` rather than widening
 * the shared type or reaching for `any`.
 */
function assertRowsReturned(result: unknown, updateLabel: string): void {
  const rows =
    typeof result === 'object' && result !== null && 'rows' in result
      ? (result as { rows: unknown }).rows
      : null;
  if (!(Array.isArray(rows) && rows.length > 0)) {
    throw new Error(
      `linkResetProbeRowsToCollection: ${updateLabel} matched zero rows — the marker literal may have drifted`
    );
  }
}

export function WebE2ETestHooks({ dbPath }: { readonly dbPath: string }) {
  const db = usePGliteDatabase();

  useEffect(() => {
    if (window.navigator.webdriver !== true) {
      Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
      return;
    }

    if (!db) {
      Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
      return;
    }

    const hooks: WebE2ETestHooks = {
      completeAssistantThreadRun: async (
        runId: string,
        status: 'cancelled' | 'completed' | 'failed'
      ): Promise<void> => {
        const completedAt = new Date();
        const result = await db.query<AssistantThreadRunRow>(
          `UPDATE brainstrike_assistant_thread_runs
           SET status = $2, completed_at = $3, updated_at = $3
           WHERE id = $1 AND status = 'running'
           RETURNING id`,
          [runId, status, completedAt]
        );
        if (result.rows[0]?.id !== runId) {
          throw new Error(`Web E2E assistant run completion matched no running row: ${runId}`);
        }
      },
      createAssistantThreadRun: async (input: WebE2EAssistantThreadRunInput): Promise<void> => {
        const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
        if (Number.isNaN(startedAt.getTime())) {
          throw new Error(`Web E2E assistant run has an invalid start time: ${input.startedAt}`);
        }
        const result = await db.query<AssistantThreadRunRow>(
          `INSERT INTO brainstrike_assistant_thread_runs
            (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'local', 'web-e2e-active-thread-projection', 'local', 'running', $4, $4, $4)
           RETURNING id`,
          [input.id, input.resourceId, input.threadId, startedAt]
        );
        if (result.rows[0]?.id !== input.id) {
          throw new Error(`Web E2E assistant run creation returned no row: ${input.id}`);
        }
      },
      dbPath,
      linkResetProbeRowsToCollection: async (collectionId: string): Promise<void> => {
        if (typeof db.transaction !== 'function') {
          throw new Error('Web E2E database handle does not expose transactions');
        }
        await db.transaction(async (tx) => {
          const fileRecordsResult: unknown = await tx.query(
            "UPDATE file_records SET embedding_set_id = $1 WHERE path LIKE 'reset-probe://%' RETURNING id",
            [collectionId]
          );
          assertRowsReturned(fileRecordsResult, 'UPDATE file_records');

          const fileChunksResult: unknown = await tx.query(
            "UPDATE file_chunks SET embedding_set_id = $1 WHERE content = 'reset probe chunk' RETURNING id",
            [collectionId]
          );
          assertRowsReturned(fileChunksResult, 'UPDATE file_chunks');
        });
      },
      qualifyDatabaseExtensions: async (): Promise<WebE2EDatabaseQualification> => {
        if (typeof db.transaction !== 'function') {
          throw new Error('Web E2E database handle does not expose transactions');
        }

        const [extensionResult, searchResult] = await Promise.all([
          db.query<ExtensionRow>(
            "SELECT extname FROM pg_extension WHERE extname IN ('pg_textsearch', 'pg_trgm', 'vector') ORDER BY extname"
          ),
          db.query<SearchQualificationRow>(
            "SELECT ('[1,0,0]'::vector(3) <=> '[1,0,0]'::vector(3))::float8 AS distance, to_tsvector('english', 'brainstrike csp qualification') @@ plainto_tsquery('english', 'brainstrike') AS full_text_match"
          ),
        ]);
        const qualificationId = crypto.randomUUID();
        const fileRecordId = `csp-file-${qualificationId}`;
        const chunkId = `csp-chunk-${qualificationId}`;
        const bm25Result = await db.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO file_records (id, name, path, size) VALUES ($1, 'csp-qualification.txt', $2, 29)",
            [fileRecordId, `csp-qualification://${qualificationId}`]
          );
          await tx.query(
            "INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, 'brainstrike csp qualification')",
            [chunkId, fileRecordId]
          );
          const result = await tx.query<Bm25QualificationRow>(
            "SELECT -(content <@> to_bm25query('brainstrike', 'idx_file_chunks_content_bm25'))::float8 AS bm25_score FROM file_chunks WHERE id = $1",
            [chunkId]
          );
          await tx.query('DELETE FROM file_chunks WHERE id = $1', [chunkId]);
          await tx.query('DELETE FROM file_records WHERE id = $1', [fileRecordId]);
          return result;
        });
        const searchRow = searchResult.rows[0];
        const bm25Row = bm25Result.rows[0];
        if (!(searchRow && bm25Row)) {
          throw new Error('Web E2E database qualification returned no result');
        }

        const vectorDistance = Number(searchRow.distance);
        const bm25Score = Number(bm25Row.bm25_score);
        const extensions = extensionResult.rows.map((row) => row.extname);
        const fullTextMatch = parseModelEnabled(searchRow.full_text_match);
        if (
          extensions.join(',') !== 'pg_textsearch,pg_trgm,vector' ||
          vectorDistance !== 0 ||
          !fullTextMatch ||
          !Number.isFinite(bm25Score) ||
          bm25Score <= 0
        ) {
          throw new Error('Web E2E database qualification failed');
        }

        return {
          bm25Score,
          extensions,
          fullTextMatch,
          vectorDistance,
        };
      },
      qualifyLocalEmbedding,
      readAssistantThreadRunStatuses: async (threadId: string): Promise<readonly string[]> => {
        const result = await db.query<AssistantThreadRunStatusRow>(
          `SELECT status FROM brainstrike_assistant_thread_runs
           WHERE thread_id = $1
           ORDER BY created_at, id`,
          [threadId]
        );
        return result.rows.map((row) => row.status);
      },
      readAssistantThreads: async (): Promise<readonly WebE2EAssistantThreadSnapshot[]> => {
        const result = await db.query<AssistantThreadRow>(
          'SELECT id, "resourceId", title, metadata FROM mastra_threads ORDER BY "updatedAt" DESC, id DESC'
        );
        return result.rows.map((row) => ({
          id: row.id,
          metadata: row.metadata,
          resourceId: row.resourceId,
          title: row.title?.trim() || 'New Thread',
        }));
      },
      readFileRowCounts: async (): Promise<WebE2EFileRowCounts> => {
        const countOf = async (table: string): Promise<number> => {
          const result = await db.query<CountRow>(`SELECT COUNT(*)::int AS count FROM ${table}`);
          const value = result.rows[0]?.count;
          const parsed = typeof value === 'number' ? value : Number(value);
          if (!Number.isFinite(parsed)) {
            throw new Error(`Count for ${table} was not numeric: ${String(value)}`);
          }
          return parsed;
        };

        return {
          fileChunks: await countOf('file_chunks'),
          fileRecords: await countOf('file_records'),
        };
      },
      readModelEnabled: async (modelId: string): Promise<boolean | null> => {
        const result = await db.query<ModelEnabledRow>(
          'SELECT is_enabled FROM models WHERE id = $1',
          [modelId]
        );
        const row = result.rows[0];
        return row ? parseModelEnabled(row.is_enabled) : null;
      },
      readResetRowCounts: async (): Promise<WebE2EResetRowCounts> => {
        const countOf = async (table: string): Promise<number> => {
          const result = await db.query<CountRow>(`SELECT COUNT(*)::int AS count FROM ${table}`);
          const value = result.rows[0]?.count;
          const parsed = typeof value === 'number' ? value : Number(value);
          if (!Number.isFinite(parsed)) {
            throw new Error(`Count for ${table} was not numeric: ${String(value)}`);
          }
          return parsed;
        };

        return {
          fileChunks: await countOf('file_chunks'),
          fileRecords: await countOf('file_records'),
          workflowSnapshots: await countOf('mastra_workflow_snapshot'),
        };
      },
      ...(Reflect.get(window, BST369_E2E_INIT_FLAG) === true
        ? { runEmbeddingModelSwitchMemoryProbe }
        : {}),
      seedFileRowsOnly: async (): Promise<void> => {
        if (typeof db.transaction !== 'function') {
          throw new Error('Web E2E database handle does not expose transactions');
        }
        const fileRecordId = crypto.randomUUID();
        const chunkId = crypto.randomUUID();

        // Deliberately omits `mastra_workflow_snapshot` — see the interface
        // doc comment. Any code path that creates the table here would make
        // it impossible for a test to prove the relation was ever absent.
        await db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO file_records (id, name, path, size) VALUES ($1, $2, $3, $4)',
            [fileRecordId, 'reset-probe.txt', `reset-probe://${fileRecordId}`, 42]
          );
          await tx.query(
            'INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, $3)',
            [chunkId, fileRecordId, 'reset probe chunk']
          );
        });
      },
      seedResetProbeRows: async (): Promise<void> => {
        if (typeof db.exec !== 'function') {
          throw new Error('Web E2E database handle does not expose exec');
        }
        if (typeof db.transaction !== 'function') {
          throw new Error('Web E2E database handle does not expose transactions');
        }
        const fileRecordId = crypto.randomUUID();
        const chunkId = crypto.randomUUID();
        const runId = crypto.randomUUID();

        // `mastra_workflow_snapshot` is created lazily by
        // `PgliteWorkflowsStore.initialize()` and by NO migration, so on a fresh
        // web profile it is absent. Create it explicitly rather than assuming
        // the assistant has run — a probe-and-skip seed could not report which
        // branch the test exercised.
        await db.exec(`
          CREATE TABLE IF NOT EXISTS mastra_workflow_snapshot (
            workflow_name TEXT NOT NULL,
            run_id TEXT NOT NULL,
            "resourceId" TEXT,
            snapshot JSONB NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (workflow_name, run_id)
          );
        `);

        await db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO file_records (id, name, path, size) VALUES ($1, $2, $3, $4)',
            [fileRecordId, 'reset-probe.txt', `reset-probe://${fileRecordId}`, 42]
          );
          await tx.query(
            'INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, $3)',
            [chunkId, fileRecordId, 'reset probe chunk']
          );
          await tx.query(
            `INSERT INTO mastra_workflow_snapshot
               (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
            ['reset-probe-workflow', runId, 'reset-probe-resource', '{"status":"suspended"}']
          );
        });
      },
      syncDatabase: async (): Promise<void> => {
        if (typeof db.syncToFs !== 'function') {
          throw new Error('Web E2E database handle does not expose syncToFs');
        }
        await db.syncToFs();
      },
    };

    window.__brainstrikeWebE2ETestHooks__ = hooks;

    return () => {
      if (window.__brainstrikeWebE2ETestHooks__ === hooks) {
        Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
      }
    };
  }, [db, dbPath]);

  return null;
}
