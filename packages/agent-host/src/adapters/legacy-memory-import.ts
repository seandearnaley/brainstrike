import type { MemoryLegacyImport, StateStore } from '@brainstrike/state-store';
import { z } from 'zod';

const Timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/** The desktop's legacy workspace memory as Main reads it (`readPgliteLegacyMemory`). */
export const LegacyMemorySchema = z.strictObject({
  resource: z
    .strictObject({
      createdAt: Timestamp,
      id: z.string().min(1),
      metadata: z.record(z.string(), z.json()).nullable(),
      updatedAt: Timestamp,
      workingMemory: z.string().nullable(),
    })
    .nullable(),
  resourceObservations: z.boolean(),
});

const MarkerSchema = z.strictObject({
  at: z.string(),
  resourceId: z.string(),
  resourceObservations: z.boolean(),
  workingMemory: z.enum(['imported', 'kept-host', 'none']),
});

/** The marker the StateStore answers with, validated. */
function marker(value: unknown): MemoryLegacyImport {
  return MarkerSchema.parse(value);
}

/**
 * Import the desktop's legacy workspace memory into the host StateStore once
 * (gap 17). The StateStore's completion marker decides: once it is written,
 * Main is never asked again. The working memory is written only when the host
 * has no resource record yet, in the marker's transaction. Resource
 * observations are not imported; the marker records whether there were any.
 * Recall vectors are not importable and are not read.
 */
export async function importLegacyMemory(
  store: Pick<StateStore, 'memory'>,
  resourceId: string,
  readLegacyMemory: () => Promise<unknown>,
  now: () => Date = () => new Date()
): Promise<MemoryLegacyImport> {
  const status = await store.memory({ operation: 'legacy-import-status', resourceId });
  if (status.value !== null && status.value !== undefined) {
    return marker(status.value);
  }
  const legacy = LegacyMemorySchema.parse(await readLegacyMemory());
  const row = legacy.resource;
  if (row && row.id !== resourceId) {
    throw new Error('The legacy memory resource is not the host memory resource');
  }
  // The native record exactly as legacy's `resourceFromRow` read it, dates as ISO text.
  const resource = row
    ? {
        createdAt: row.createdAt,
        id: row.id,
        ...(row.metadata ? { metadata: row.metadata } : {}),
        updatedAt: row.updatedAt,
        ...(row.workingMemory === null ? {} : { workingMemory: row.workingMemory }),
      }
    : null;
  const imported = await store.memory({
    at: now().toISOString(),
    operation: 'legacy-import',
    resource,
    resourceId,
    resourceObservations: legacy.resourceObservations,
  });
  return marker(imported.value);
}
