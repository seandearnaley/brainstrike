// @vitest-environment node

import type { SourceCatalogPort, SourceCatalogRecord } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { loadNativeGraphRecords, type NativeIndexActivationGraph } from '../native-index-graph';
import type { NativeIndexSettings } from '../native-index-settings';
import { SPACE, textSettings, vectorSettings } from './helpers/native-index-settings';

function graph(settings: NativeIndexSettings): NativeIndexActivationGraph {
  return {
    controller: new AbortController(),
    generation: 1,
    leases: new Map(),
    settings,
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
  expect(await loadNativeGraphRecords(graph(textSettings()), () => {}, catalog)).toEqual([]);
});
test('a semantic vector space retains its rootless imported sources', async () => {
  const imported = source(SPACE);
  const catalog: SourceCatalogPort = { sourceCatalog: async () => ({ files: [imported] }) };
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    chunksCount: _chunksCount,
    ...canonical
  } = imported;
  expect(await loadNativeGraphRecords(graph(vectorSettings()), () => {}, catalog)).toEqual([
    canonical,
  ]);
});
