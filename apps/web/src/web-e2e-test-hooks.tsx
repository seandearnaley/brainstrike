import { usePGliteDatabase } from '@brainstrike/db';
import { useEffect } from 'react';

interface ModelEnabledRow {
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  readonly is_enabled: boolean | number | string | null;
}

export interface WebE2ETestHooks {
  readonly dbPath: string;
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
