import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';
import { buildMigratedSnapshot } from './migrated-test-db.js';

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
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-db-snapshot-'));
  const snapshotPath = path.join(dir, 'migrated.tar');
  const bytes = await buildMigratedSnapshot();
  await writeFile(snapshotPath, bytes);
  provide('dbSnapshotPath', snapshotPath);

  return async () => {
    await rm(dir, { force: true, recursive: true });
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    dbSnapshotPath: string;
  }
}
