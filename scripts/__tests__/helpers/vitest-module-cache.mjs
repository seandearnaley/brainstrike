import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Each script-test Vitest context owns its module-cache invalidation and cleanup.
 * https://main.vitest.dev/config/fsmodulecachepath
 */
export async function withVitestModuleCache(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'brainstrike-script-vitest-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
