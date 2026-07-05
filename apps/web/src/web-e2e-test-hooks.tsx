import { useBrainstrikeExecutionDbClient, usePGliteDatabase } from '@brainstrike/db';
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

export interface WebE2EAssistantThreadSnapshot {
  readonly id: string;
  readonly metadata: unknown;
  readonly resourceId: string;
  readonly title: string;
}

export interface WebE2ETestHooks {
  readonly dbPath: string;
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

const ASSISTANT_THREADS_SQL =
  'SELECT id, "resourceId", title, metadata FROM mastra_threads ORDER BY "updatedAt" DESC, id DESC';

function toAssistantThreadSnapshots(
  rows: readonly AssistantThreadRow[]
): readonly WebE2EAssistantThreadSnapshot[] {
  return rows.map((row) => ({
    id: row.id,
    metadata: row.metadata,
    resourceId: row.resourceId,
    title: row.title?.trim() || 'New Thread',
  }));
}

type PGliteDbHandle = NonNullable<ReturnType<typeof usePGliteDatabase>>;
type ExecutionDbClient = NonNullable<ReturnType<typeof useBrainstrikeExecutionDbClient>>;

function createPGliteWebE2ETestHooks(db: PGliteDbHandle, dbPath: string): WebE2ETestHooks {
  return {
    dbPath,
    readAssistantThreads: async (): Promise<readonly WebE2EAssistantThreadSnapshot[]> => {
      const result = await db.query<AssistantThreadRow>(ASSISTANT_THREADS_SQL);
      return toAssistantThreadSnapshots(result.rows);
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
}

/**
 * Browser Turso hooks (A7 cutover): the same introspection surface over the
 * provider-owned WAL single-writer execution client, with SQLite `?`
 * placeholders. `syncDatabase` resolves without a driver call because browser
 * Turso WAL commits are durable in OPFS with no explicit flush (proven by
 * turso-browser-opfs-durability.browser.test.ts). Reads against relations the
 * browser Turso baseline does not own (e.g. mastra_threads) propagate their
 * driver error — never masked as an empty result.
 */
function createTursoWebE2ETestHooks(client: ExecutionDbClient, dbPath: string): WebE2ETestHooks {
  return {
    dbPath,
    readAssistantThreads: async (): Promise<readonly WebE2EAssistantThreadSnapshot[]> => {
      const result = await client.db.query<AssistantThreadRow>(ASSISTANT_THREADS_SQL);
      return toAssistantThreadSnapshots(result.rows);
    },
    readModelEnabled: async (modelId: string): Promise<boolean | null> => {
      const result = await client.db.query<ModelEnabledRow>(
        'SELECT is_enabled FROM models WHERE id = ?',
        [modelId]
      );
      const row = result.rows[0];
      return row ? parseModelEnabled(row.is_enabled) : null;
    },
    syncDatabase: async (): Promise<void> => {
      // Durability is a property of the committed WAL store; nothing to flush.
    },
  };
}

export function WebE2ETestHooks({ dbPath }: { readonly dbPath: string }) {
  const pgliteDb = usePGliteDatabase();
  const executionClient = useBrainstrikeExecutionDbClient();

  useEffect(() => {
    if (window.navigator.webdriver !== true) {
      Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
      return;
    }

    const hooks = pgliteDb
      ? createPGliteWebE2ETestHooks(pgliteDb, dbPath)
      : executionClient?.runtimeEngine === 'turso'
        ? createTursoWebE2ETestHooks(executionClient, dbPath)
        : null;

    if (!hooks) {
      Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
      return;
    }

    window.__brainstrikeWebE2ETestHooks__ = hooks;

    return () => {
      if (window.__brainstrikeWebE2ETestHooks__ === hooks) {
        Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
      }
    };
  }, [pgliteDb, executionClient, dbPath]);

  return null;
}
