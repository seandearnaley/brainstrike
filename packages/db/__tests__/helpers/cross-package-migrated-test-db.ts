import { readFile } from 'node:fs/promises';
import { migrate, wasmLoader } from '@brainstrike/db';
import { createBrainstrikePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { inject } from 'vitest';

/**
 * Migrated PGlite for OTHER workspace packages' suites, exported as the
 * source-only subpath `@brainstrike/db/test-support/migrated-test-db` (never
 * built into dist, never in a browser bundle).
 *
 * Same template-snapshot pattern as migrated-test-db.ts: migrate a template
 * once, dump its data dir, and restore an isolated copy per call, so each test
 * keeps its own fully migrated database without paying `initdb` plus the whole
 * migration chain. This module exists beside migrated-test-db.ts rather than
 * re-exporting it because db's own helper imports db internals by relative
 * source path (db's lane has no `@brainstrike/db` alias), while a consumer has
 * to import db by package name: its vitest config aliases that to db source,
 * and its type-check resolves it to db's declarations instead of compiling
 * db's sources under the consumer's compiler options.
 *
 * Do NOT use it where the subject is migration, boot, reopen-on-disk or
 * instantiation behavior; those tests must keep running the real cold path.
 *
 * There used to be a second export, `createNumberedChainTestDb`, for a database
 * built by the NUMBERED `MigrationRunner` instead. It existed because the two
 * runners genuinely built different schemas -- the numbered chain created
 * `file_records.embedding`, which production never had, and lacked
 * `embedding_cache` and `token_cache`, which only the drizzle manifest created.
 * Since the collapse to one current-schema DDL (ADR-0020) both runners apply the
 * SAME single migration and differ only in which ledger table they write, so
 * the distinction was a name without a difference and the variant is gone.
 * `migrated-test-db-contract.integration.test.ts` now asserts that parity
 * directly, with no divergence allowlist.
 */

declare module 'vitest' {
  interface ProvidedContext {
    /** Set by db-snapshot-global.ts; absent in lanes that do not declare it. */
    dbSnapshotPath: string;
  }
}

type TemplateBytes = Uint8Array<ArrayBuffer>;

/**
 * Module scope, so with the default `isolate: true` each test FILE fills these
 * once and every test in the file restores from the same bytes.
 */
let drizzleTemplate: Promise<TemplateBytes> | undefined;

async function dumpMigratedTemplate(
  migrateTemplate: (template: PGlite) => Promise<void>
): Promise<TemplateBytes> {
  // The construction and migration every replaced call site performed.
  const template = await wasmLoader.createPGlite('memory://');
  try {
    await migrateTemplate(template);
    // 'none': the tarball is restored many times, so decompressing it on every
    // restore would cost more than the memory it saves.
    const dump = await template.dumpDataDir('none');
    return new Uint8Array(await dump.arrayBuffer());
  } finally {
    await template.close();
  }
}

/**
 * A lane whose vitest project declares packages/db/__tests__/helpers/
 * db-snapshot-global.ts as `globalSetup` migrates once per run, and each file
 * reads that tarball. A lane without it (one whose config does not declare it,
 * or a package's single-process coverage run over its base config) migrates
 * one template per test file here. The restored databases are identical either
 * way; only the number of cold migrations differs.
 */
async function loadDrizzleTemplate(): Promise<TemplateBytes> {
  const snapshotPath = inject('dbSnapshotPath');
  if (snapshotPath) {
    return new Uint8Array(await readFile(snapshotPath));
  }
  return await dumpMigratedTemplate(migrate);
}

async function restore(bytes: TemplateBytes): Promise<PGlite> {
  // The production direct-host factory `wasmLoader.createPGlite` uses, so the
  // restored instance carries the same engine and client extension set.
  return await createBrainstrikePglite({ loadDataDir: new Blob([bytes]) });
}

/**
 * Returns a fresh, isolated in-memory PGlite holding exactly what
 * `wasmLoader.createPGlite('memory://')` followed by `migrate(db)` produces.
 * The caller owns the instance and must `close()` it.
 */
export async function createMigratedTestDb(): Promise<PGlite> {
  drizzleTemplate ??= loadDrizzleTemplate();
  return await restore(await drizzleTemplate);
}
