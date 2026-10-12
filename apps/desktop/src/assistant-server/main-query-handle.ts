/**
 * Minimal query surface the snapshot and rewind modules take instead of the
 * concrete main-process DB client, so the main-process handle, a PGlite
 * instance and test doubles all satisfy it.
 */
export interface MainQueryHandle {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}
