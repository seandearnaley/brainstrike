import { writeFile } from 'node:fs/promises';
import { getCompileCacheDir } from 'node:module';
import { join } from 'node:path';
import { openHostStateIndex } from '../../src/host-state-index.ts';

/** @param {import('@brainstrike/host-lease').HostStartOptions} options
 * @param {import('../../src/runtime.ts').HostStartupContext} context */
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
    // index deadlines.
    close: async () => {
      const startedAt = performance.now();
      await native.close();
      await writeFile(
        join(directory, 'index-close.json'),
        JSON.stringify({ elapsedMs: performance.now() - startedAt })
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
