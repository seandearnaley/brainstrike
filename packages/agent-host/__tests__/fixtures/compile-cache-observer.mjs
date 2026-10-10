import { writeFileSync } from 'node:fs';
import { getCompileCacheDir } from 'node:module';
import { join } from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';

// Observation only: --import runs before the real worker's static module graph.
// Enabling a cache here would conceal the missing parent-to-worker inheritance.
const directory = process.env.BRAINSTRIKE_CACHE_PROBE;
if (!directory) {
  throw new Error('The cache probe requires its disposable output directory');
}
if (!isMainThread) {
  writeFileSync(
    join(directory, `worker-${threadId}.json`),
    JSON.stringify({ directory: getCompileCacheDir() ?? null, entry: process.argv[1], threadId })
  );
}
