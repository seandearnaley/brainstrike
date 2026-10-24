import path from 'node:path';

/**
 * Worker and module entries that workspace packages name beside their own
 * module (`new URL('./writer-worker.js', import.meta.url)`) and Node loads by
 * path. A Node bundle of workspace code emits each one beside its chunks, so
 * every sibling a bundled package names resolves to its bundled entry. Each
 * name is unique across the workspace: two packages naming the same sibling
 * would collide in one bundle directory.
 */
export function nodeRuntimeEntryPoints(packagesRoot: string): Record<string, string> {
  return {
    'host-state-index-worker': path.join(packagesRoot, 'agent-host/src/host-state-index-worker.ts'),
    'keyring-native-entry': path.join(packagesRoot, 'agent-host/src/adapters/keyring-native-entry.ts'),
    'memory-storage-calculator': path.join(
      packagesRoot,
      'agent-host/src/adapters/memory-storage-calculator.ts'
    ),
    'state-projection': path.join(packagesRoot, 'agent-host/src/state-projection.ts'),
    'writer-worker': path.join(packagesRoot, 'indexer/src/writer-worker.ts'),
  };
}

/**
 * The state-store writer worker is plain ESM that state-store names beside
 * itself as `./writer-worker.mjs`, so a bundle emits it with that extension
 * (it cannot share the `writer-worker` name with the indexer's `.js` worker).
 */
export function stateStoreWriterWorkerEntry(packagesRoot: string): string {
  return path.join(packagesRoot, 'state-store/src/writer-worker.mjs');
}
