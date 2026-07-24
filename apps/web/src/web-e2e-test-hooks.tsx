import { usePGliteDatabase } from '@brainstrike/db';
import { useEffect } from 'react';

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

export interface WebE2ETestHooks {
  readonly dbPath: string;
  readonly qualifyDatabaseExtensions: () => Promise<WebE2EDatabaseQualification>;
  readonly qualifyLocalEmbedding: (
    deviceHint?: 'wasm' | 'webgpu'
  ) => Promise<WebE2EEmbeddingQualification>;
  readonly readAssistantThreads: () => Promise<readonly WebE2EAssistantThreadSnapshot[]>;
  readonly readModelEnabled: (modelId: string) => Promise<boolean | null>;
  readonly syncDatabase: () => Promise<void>;
}

declare global {
  interface Window {
    __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks;
  }
}

function parseModelEnabled(value: ModelEnabledRow['is_enabled']): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
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
      dbPath,
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
      qualifyLocalEmbedding: async (deviceHint = 'wasm'): Promise<WebE2EEmbeddingQualification> => {
        const dtype = deviceHint === 'webgpu' ? 'fp16' : 'q4';
        const { getEmbeddingQueue } = await import('./create-embedding-queue');
        const queue = getEmbeddingQueue();
        const result = await queue.add({
          deviceHint,
          dtype,
          id: `csp-embedding-${crypto.randomUUID()}`,
          kind: 'embed',
          maxBatchSize: 1,
          model: 'Xenova/all-MiniLM-L6-v2',
          targetDimension: 384,
          texts: ['Brainstrike production CSP qualification'],
          truncateDim: 384,
        });
        const vector = result.vectors[0];
        const dimensions = result.metadata.dimensions ?? vector?.length ?? 0;
        const finite =
          vector !== undefined &&
          vector.length === 384 &&
          Array.from(vector).every((value) => Number.isFinite(value));
        if (
          result.metadata.device !== deviceHint ||
          result.metadata.dtype !== dtype ||
          result.metadata.fallbackApplied !== false ||
          dimensions !== 384 ||
          !finite
        ) {
          throw new Error('Web E2E local embedding qualification failed');
        }
        return {
          device: result.metadata.device,
          dimensions,
          dtype: result.metadata.dtype,
          fallbackApplied: result.metadata.fallbackApplied,
          finite,
        };
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
      readModelEnabled: async (modelId: string): Promise<boolean | null> => {
        const result = await db.query<ModelEnabledRow>(
          'SELECT is_enabled FROM models WHERE id = $1',
          [modelId]
        );
        const row = result.rows[0];
        return row ? parseModelEnabled(row.is_enabled) : null;
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
