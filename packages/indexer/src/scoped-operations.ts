import type { IndexWriter } from './store.js';

/**
 * Desktop's `ScopedIndexerPort`, by operation, plus `info`. Desktop's process
 * splits these between its read-only connection and its writer thread; a host
 * whose one IndexWriter also answers reads (the browser's index worker,
 * BST-1940) serves them all from it.
 */
export const SCOPED_INDEX_OPERATIONS = [
  'commitScopedFile',
  'commitScopedTextFile',
  'coverageBatch',
  'coverageScope',
  'info',
  'prepareScopedFile',
  'readScopedFileChunkBounds',
  'readScopedFilePage',
  'removeScopedFile',
  'replaceFileBindings',
  'searchScopes',
  'verifyScopedManifest',
] as const;
export type ScopedIndexOperation = (typeof SCOPED_INDEX_OPERATIONS)[number];

export function scopedIndexOperations(
  writer: IndexWriter
): Readonly<Record<ScopedIndexOperation, (input: unknown) => unknown>> {
  const { scoped } = writer;
  return {
    commitScopedFile: (input) => scoped.commitVector(input),
    commitScopedTextFile: (input) => scoped.commitText(input),
    coverageBatch: (input) => scoped.coverageBatch(input),
    coverageScope: (input) => scoped.coverage(input),
    // As desktop's `info`: the store's identity as it stands, not as it opened.
    info: () => ({ ...writer.info, ...writer.identity }),
    prepareScopedFile: (input) => scoped.prepare(input),
    readScopedFileChunkBounds: (input) => scoped.readFileChunkBounds(input),
    readScopedFilePage: (input) => scoped.readFilePage(input),
    removeScopedFile: (input) => scoped.remove(input),
    replaceFileBindings: (input) => scoped.replaceBindings(input),
    searchScopes: (input) => scoped.search(input),
    verifyScopedManifest: (input) => scoped.verifyManifest(input),
  };
}
