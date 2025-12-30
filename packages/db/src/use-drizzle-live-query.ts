/**
 * Drizzle-aware Live Query Hook
 *
 * Provides a type-safe wrapper around usePGliteLiveQuery that works with
 * Drizzle query builders. Uses Drizzle's toSQL() to extract the SQL and
 * parameters, then passes them to the underlying live query system.
 *
 * This allows type-safe live queries while leveraging PGlite's live extension.
 */

import type { PgSelect } from 'drizzle-orm/pg-core';
import { useCallback, useMemo, useState } from 'react';
import { type LiveQueryHookResult, usePGliteLiveQuery } from './use-live-query.js';

type DrizzleLiveQueryOptions = {
  /** Enable or disable the query */
  readonly enabled?: boolean;
  /** Offset for pagination */
  readonly offset?: number;
  /** Limit for pagination */
  readonly limit?: number;
};

type DrizzleQuery<T> = {
  toSQL(): { sql: string; params: unknown[] };
  // Type inference helper - the actual type comes from Drizzle's SelectResult
  _phantom?: T;
};

/**
 * Extracts SQL and params from a Drizzle query using toSQL()
 */
function extractQueryDetails(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle query types are complex unions
  query: DrizzleQuery<any>
): { sql: string; params: readonly unknown[] } {
  const { sql, params } = query.toSQL();
  return { sql, params };
}

/**
 * Hook for live queries using Drizzle query builders.
 *
 * @example
 * ```typescript
 * import { eq } from 'drizzle-orm';
 * import { useDrizzleLiveQuery } from '@brainstrike/db';
 * import { fileRecords } from './schema';
 *
 * function MyComponent() {
 *   const db = useDrizzleDatabase(); // Your Drizzle DB instance
 *   const query = db.select().from(fileRecords).where(eq(fileRecords.size, 100));
 *
 *   const { rows, loading, error } = useDrizzleLiveQuery(query);
 *   // rows is typed as FileRecord[]
 * }
 * ```
 */
export function useDrizzleLiveQuery<T extends Record<string, unknown>>(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle PgSelect has complex generic types
  query: PgSelect<any, any, any> | DrizzleQuery<T> | null,
  options: DrizzleLiveQueryOptions = {}
): LiveQueryHookResult<T> {
  const { enabled = true, offset, limit } = options;

  // Extract SQL and params from the Drizzle query
  const queryDetails = useMemo(() => {
    if (!query) {
      return null;
    }
    try {
      return extractQueryDetails(query as DrizzleQuery<T>);
    } catch {
      return null;
    }
  }, [query]);

  // Build options object, only including defined properties
  const liveQueryOptions = useMemo(() => {
    const baseOptions: {
      query: string;
      params?: readonly unknown[];
      enabled: boolean;
      offset?: number;
      limit?: number;
    } = {
      query: queryDetails?.sql ?? 'SELECT 1 WHERE false', // Fallback that returns no rows
      enabled: enabled && Boolean(queryDetails),
    };

    if (queryDetails?.params) {
      baseOptions.params = queryDetails.params;
    }
    if (offset !== undefined) {
      baseOptions.offset = offset;
    }
    if (limit !== undefined) {
      baseOptions.limit = limit;
    }

    return baseOptions;
  }, [queryDetails, enabled, offset, limit]);

  // Use the underlying live query hook
  const result = usePGliteLiveQuery<T>(liveQueryOptions);

  return result;
}

/**
 * Hook for live queries with manual SQL refresh capability.
 * Use this when you need to manually trigger query updates.
 *
 * @example
 * ```typescript
 * const { rows, loading, refresh } = useDrizzleLiveQueryWithRefresh(query);
 *
 * // Manually refresh when needed
 * await refresh();
 * ```
 */
export function useDrizzleLiveQueryWithRefresh<T extends Record<string, unknown>>(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle PgSelect has complex generic types
  query: PgSelect<any, any, any> | DrizzleQuery<T> | null,
  options: DrizzleLiveQueryOptions = {}
): LiveQueryHookResult<T> & {
  /** Refresh counter for forcing re-evaluation */
  refreshCount: number;
  /** Force a refresh of the query */
  forceRefresh: () => void;
} {
  const [refreshCount, setRefreshCount] = useState(0);

  const forceRefresh = useCallback(() => {
    setRefreshCount((c) => c + 1);
  }, []);

  const result = useDrizzleLiveQuery(query, options);

  return useMemo(
    () => ({
      ...result,
      refreshCount,
      forceRefresh,
    }),
    [result, refreshCount, forceRefresh]
  );
}

export type { DrizzleLiveQueryOptions, DrizzleQuery };
