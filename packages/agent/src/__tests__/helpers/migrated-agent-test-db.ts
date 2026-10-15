import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '../../memory-settings';
import { createPgliteMastraMemory } from '../../pglite-mastra-memory';
import type { PgliteDatabase } from '../../pglite-mastra-memory/types';

/** A suite's own PGlite construction, given the restore source when there is one. */
type CreateTestPglite = (options?: { readonly loadDataDir?: Blob }) => Promise<PGlite>;

/**
 * Template-snapshot factory, the same pattern as
 * `@brainstrike/db/test-support/migrated-test-db`: the first call builds ONE
 * template per test file (module scope; `isolate: true` gives each file a fresh
 * module graph) with `create()` followed by `prepare`, dumps its data dir, and
 * every call restores an isolated copy through the same `create`. Each instance
 * therefore has exactly the construction and contents of a cold `create()` plus
 * `prepare` — the construction matters, because the engine set writes its
 * `pg_textsearch` preload into postgresql.conf — without paying `initdb` per
 * test. Each caller owns its instance and must close it.
 */
function snapshotTestDbFactory(
  create: CreateTestPglite,
  prepare?: (template: PGlite) => Promise<unknown>
): () => Promise<PGlite> {
  let templateBytes: Promise<Uint8Array<ArrayBuffer>> | undefined;
  async function buildTemplateBytes(): Promise<Uint8Array<ArrayBuffer>> {
    const template = await create();
    try {
      await prepare?.(template);
      // 'none': restored many times, so per-restore decompression would cost more.
      const dump = await template.dumpDataDir('none');
      return new Uint8Array(await dump.arrayBuffer());
    } finally {
      await template.close();
    }
  }
  return async () => {
    templateBytes ??= buildTemplateBytes();
    return await create({ loadDataDir: new Blob([await templateBytes]) });
  };
}

/**
 * Returns a fresh agent-memory database: engine extension set with the Mastra
 * memory schema already created.
 */
export const createAgentMemoryTestDb = snapshotTestDbFactory(createEnginePglite, (template) =>
  createPgliteMastraMemory({
    database: template as unknown as PgliteDatabase,
    memorySettings: CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  })
);

/*
 * Empty databases, for suites whose subject creates its own schema: each is the
 * database the named construction yields on a fresh cluster, so the suite's own
 * schema creation still runs cold on it. Only `initdb` is shared per file.
 */

/** The database `createEnginePglite()` returns. */
export const createPristineEngineTestDb = snapshotTestDbFactory(createEnginePglite);

/** The database a bare `new PGlite()` (no extensions) opens. */
export const createPristineBareTestDb = snapshotTestDbFactory((options) => PGlite.create(options));

/** The database `PGlite.create({ extensions: { vector } })` returns. */
export const createPristineVectorTestDb = snapshotTestDbFactory((options) =>
  PGlite.create({ ...options, extensions: { vector } })
);
