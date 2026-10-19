import { readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { getCompileCacheDir } from 'node:module';
import { join } from 'node:path';
import { openHostStateIndex } from '../../dist/host-state-index.js';

/** Files under the compile cache directory, or null when this host runs without one. */
function cacheFiles(directory) {
  return directory === undefined
    ? null
    : readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) =>
        entry.isFile()
      ).length;
}

/** @param {import('@brainstrike/host-lease').HostStartOptions} options
 * @param {import('../../src/runtime.js').HostStartupContext} context */
export async function createHostPlatform(options, context) {
  const directory = process.env.BRAINSTRIKE_CACHE_PROBE;
  if (!directory) {
    throw new Error('The cache probe requires its disposable output directory');
  }
  await writeFile(
    join(directory, 'parent.json'),
    JSON.stringify({ directory: getCompileCacheDir() ?? null })
  );
  const native = await openHostStateIndex(options.root);
  await context.register(() => native.close());
  return {
    // The index's own close: its worker and nested writer close and exit under the
    // index deadlines. Measured before this host's own exit persists its cache.
    close: async () => {
      const cache = getCompileCacheDir();
      const before = cacheFiles(cache);
      const startedAt = performance.now();
      await native.close();
      const elapsedMs = performance.now() - startedAt;
      await writeFile(
        join(directory, 'index-close.json'),
        JSON.stringify({ after: cacheFiles(cache), before, elapsedMs })
      );
    },
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: {}, yolo: false }),
    resolveModel: async () => {
      throw new Error('The compile-cache probe must not invoke a provider');
    },
    stateIndexer: native.indexer,
    tools: {},
  };
}
