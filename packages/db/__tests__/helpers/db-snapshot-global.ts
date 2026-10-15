import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { buildMigratedSnapshot } from './migrated-test-db.js';

const DB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATION_SOURCES = ['src/migrations', 'src/drizzle'].map((dir) => path.join(DB_ROOT, dir));

/**
 * Vitest globalSetup: builds the migrated PGlite snapshot ONCE per vitest
 * process and hands its on-disk path to every test worker via `provide`.
 *
 * Runs once per `vitest run` invocation (i.e. once per db lane), not once per
 * file or per test — this is the whole point: the 60-migration chain executes a
 * single time, and the hundreds of per-test database boots become cheap
 * `loadDataDir` restores (see migrated-test-db.ts). A unique temp dir per
 * process keeps concurrent lane runs from colliding, and the returned teardown
 * removes it.
 *
 * Watch mode keeps this process, and the migration modules it evaluated, alive
 * across reruns, so the snapshot cannot follow a migration edit. Rather than
 * test against the stale schema, a rerun after such an edit fails and asks for
 * a restart.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-db-snapshot-'));
  const snapshotPath = path.join(dir, 'migrated.tar');
  await writeFile(snapshotPath, await buildMigratedSnapshot());
  project.provide('dbSnapshotPath', snapshotPath);

  let changedMigration: string | undefined;
  project.vite.watcher.on('all', (_event, file) => {
    if (MIGRATION_SOURCES.some((source) => file.startsWith(source + path.sep))) {
      changedMigration ??= path.relative(DB_ROOT, file);
    }
  });
  project.onTestsRerun(() => {
    if (changedMigration) {
      throw new Error(
        `${changedMigration} changed after the migrated test snapshot was built. Restart Vitest to rebuild it.`
      );
    }
  });

  return async () => {
    await rm(dir, { force: true, recursive: true });
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    dbSnapshotPath: string;
  }
}
