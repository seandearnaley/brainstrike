/** The desktop's PGlite query surface the legacy memory read needs. */
export interface LegacyMemoryDatabase {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The legacy workspace memory as Main reads it once for the host's import (gap 17). */
export interface PgliteLegacyMemory {
  /** The resource's `mastra_resources` row, timestamps as ISO text, or null when it has none. */
  readonly resource: Readonly<Record<string, unknown>> | null;
  /** Whether the resource had resource-scope observational memory, which is not imported. */
  readonly resourceObservations: boolean;
}

function isoTimestamps(row: unknown): Readonly<Record<string, unknown>> {
  if (typeof row !== 'object' || row === null) {
    throw new TypeError('A PGlite memory row must be an object.');
  }
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      value instanceof Date ? value.toISOString() : value,
    ])
  );
}

/**
 * One resource's legacy working memory and whether it had resource-scope
 * observations, read once for the host's import into its StateStore.
 * Read-only; the host validates the row. Recall vectors are not read: the
 * host's index cannot import them.
 */
export async function readPgliteLegacyMemory(
  db: LegacyMemoryDatabase,
  resourceId: string
): Promise<PgliteLegacyMemory> {
  const resources = await db.query(
    `SELECT id, "workingMemory", metadata, "createdAt", "updatedAt"
     FROM mastra_resources WHERE id = $1`,
    [resourceId]
  );
  const observations = await db.query(
    `SELECT 1 FROM mastra_observational_memory
     WHERE "resourceId" = $1 AND scope = 'resource' LIMIT 1`,
    [resourceId]
  );
  const [resource] = resources.rows;
  return {
    resource: resource === undefined ? null : isoTimestamps(resource),
    resourceObservations: observations.rows.length > 0,
  };
}
