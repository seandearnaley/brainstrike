import type { NativeCanonicalCatalogRecord } from '@brainstrike/canonical-ingestion';
import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type { SourceFileRecord } from '@brainstrike/types';
import { vi } from 'vitest';

function sourceRecord(record: NativeCanonicalCatalogRecord): SourceFileRecord {
  if (record.contentHash === null) {
    throw new Error('Current source records require their content hash.');
  }
  return {
    ...record,
    chunksCount: null,
    contentHash: record.contentHash,
    createdAt: '2026-10-13T00:00:00.000Z',
    path: record.path ?? record.fileName,
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
}
export function createActivationCatalogFixture() {
  const catalog = {
    collections: vi.fn<CollectionPort['collections']>(),
    sourceCatalog: vi.fn<SourceCatalogPort['sourceCatalog']>(),
    workspaceRoots: vi.fn<WorkspaceRootPort['workspaceRoots']>(),
  };
  const setRecords = (read: () => readonly NativeCanonicalCatalogRecord[]): void => {
    catalog.sourceCatalog.mockImplementation(async (request) => {
      const records = read().map(sourceRecord);
      if (request.operation === 'inventory') {
        return {
          files: records.filter((record) => record.embeddingSetId === request.embeddingSetId),
        };
      }
      if (request.operation === 'read') {
        return { files: records.filter((record) => request.fileIds.includes(record.fileId)) };
      }
      throw new Error(`Unexpected catalog mutation ${request.operation}`);
    });
  };
  const setRoot = (id = 'root'): void => {
    catalog.workspaceRoots.mockResolvedValue({
      roots: [
        {
          createdAt: 1,
          displayName: 'root',
          id,
          kind: 'path',
          lastVerifiedAt: 1,
          path: '/actual/root',
          status: 'live',
        },
      ],
    });
  };
  const reset = (): void => {
    catalog.collections.mockResolvedValue({
      collections: [
        {
          createdAt: '2026-10-13T00:00:00.000Z',
          dimensions: 1536,
          distance: 'cosine',
          id: 'selected',
          modelId: 'text-embedding-3-small',
          modelKey: 'openai::text-embedding-3-small',
        },
      ],
    });
    catalog.workspaceRoots.mockResolvedValue({ roots: [] });
    setRecords(() => []);
  };
  return { catalog, reset, setRecords, setRoot };
}
