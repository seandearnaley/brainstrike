// @vitest-environment node

import type { SourceCatalogPort, SourceCatalogRecord } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { loadNativeGraphRecords, type NativeIndexActivationGraph } from '../native-index-graph';

function graph(collection: string | null): NativeIndexActivationGraph {
  return {
    controller: new AbortController(),
    generation: 1,
    leases: new Map(),
    settings: {
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: collection,
      mode: 'TEXT',
      paused: false,
      selection: null,
      worktreeOptIns: new Set(),
    },
    watchFailures: new Map(),
  };
}
function source(collection: string | null): SourceCatalogRecord {
  return {
    chunksCount: 1,
    chunksProcessed: true,
    content: 'Import',
    contentHash: 'c'.repeat(64),
    createdAt: '2026-10-13T20:00:00.000Z',
    embeddingSetId: collection,
    fileId: 'import-id',
    fileName: 'import.txt',
    path: 'import.txt',
    rootId: null,
    stat: { mtimeMs: null, size: 6 },
    updatedAt: '2026-10-13T20:00:00.000Z',
  };
}
test('uncollected rootless imports are outside TEXT workspace authority', async () => {
  const catalog: SourceCatalogPort = { sourceCatalog: async () => ({ files: [source(null)] }) };
  expect(await loadNativeGraphRecords(graph(null), () => {}, catalog)).toEqual([]);
});
test('a selected collection retains its rootless imported sources', async () => {
  const imported = source('chosen');
  const catalog: SourceCatalogPort = { sourceCatalog: async () => ({ files: [imported] }) };
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    chunksCount: _chunksCount,
    ...canonical
  } = imported;
  expect(await loadNativeGraphRecords(graph('chosen'), () => {}, catalog)).toEqual([canonical]);
});
