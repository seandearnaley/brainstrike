import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';

/**
 * The enabled `models` rows, the catalog host admission reads before it admits
 * a catalog selection (production-desktop-capabilities readDesktopCatalogSelection).
 */
const ENABLED_MODELS_QUERY =
  'SELECT id, provider_id AS "providerId" FROM models WHERE is_enabled = true';
const NO_PARAMS: readonly unknown[] = [];

export type EnabledCatalogModels =
  | { readonly state: 'loading' }
  | { readonly message: string; readonly state: 'error' }
  /** `provider::model` keys, the selection's composite identity. */
  | { readonly keys: ReadonlySet<string>; readonly state: 'ready' };

function readKey(row: Record<string, unknown>): string {
  const { id, providerId } = row;
  if (typeof id !== 'string' || typeof providerId !== 'string') {
    throw new Error(`An enabled model row has no catalog identity: ${JSON.stringify(row)}`);
  }
  return `${providerId}::${id}`;
}

/** Live: a Settings toggle or any other write to `models` reaches the composer at once. */
export function useEnabledCatalogModels(): EnabledCatalogModels {
  const database = usePGliteDatabase();
  const live = usePGliteLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('host-enabled-catalog-models'),
    params: NO_PARAMS,
    query: ENABLED_MODELS_QUERY,
  });
  return useMemo<EnabledCatalogModels>(() => {
    // With no database yet the query has not run: nothing is known.
    if (!database || live.loading) {
      return { state: 'loading' };
    }
    if (live.error) {
      return { message: live.error.message, state: 'error' };
    }
    try {
      return { keys: new Set(live.rows.map(readKey)), state: 'ready' };
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error), state: 'error' };
    }
  }, [database, live.error, live.loading, live.rows]);
}
