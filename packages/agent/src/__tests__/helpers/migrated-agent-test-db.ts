import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '../../memory-settings';
import { createPgliteMastraMemory } from '../../pglite-mastra-memory';
import type { PgliteDatabase } from '../../pglite-mastra-memory/types';

let snapshotBytesPromise: Promise<Uint8Array<ArrayBuffer>> | undefined;

async function buildSnapshotBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const template = await createEnginePglite();
  try {
    await createPgliteMastraMemory({
      database: template as unknown as PgliteDatabase,
      memorySettings: CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
    });
    const dump = await template.dumpDataDir('none');
    return new Uint8Array(await dump.arrayBuffer());
  } finally {
    await template.close();
  }
}

async function loadSnapshotBytes(): Promise<Uint8Array<ArrayBuffer>> {
  snapshotBytesPromise ??= buildSnapshotBytes();
  return snapshotBytesPromise;
}

/**
 * Returns a fresh agent-memory database restored from immutable pristine bytes.
 * Each caller owns an independent PGlite instance and must close it.
 */
export async function createAgentMemoryTestDb(): Promise<PGlite> {
  const snapshotBytes = await loadSnapshotBytes();
  return createEnginePglite({ loadDataDir: new Blob([snapshotBytes]) });
}
