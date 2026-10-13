import { projectModelCatalog } from '@brainstrike/assistant-contract';
import type {
  CollectionPort,
  SourceCatalogPort,
  WorkspaceRootPort,
} from '@brainstrike/state-store';
import type { SourceFileRecord } from '@brainstrike/types';
import { vi } from 'vitest';
import type { NativeCanonicalCatalogRecord } from '../native-canonical-catalog';

export function sourceRecord(record: NativeCanonicalCatalogRecord): SourceFileRecord {
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
  const modelCatalog = {
    read: vi.fn(async () => projectModelCatalog({ models: [], providers: [] })),
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
          dimensions: 384,
          distance: 'cosine',
          id: 'selected',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          modelKey: 'transformers::Xenova/all-MiniLM-L6-v2',
        },
      ],
    });
    catalog.workspaceRoots.mockResolvedValue({ roots: [] });
    modelCatalog.read.mockResolvedValue(projectModelCatalog({ models: [], providers: [] }));
    setRecords(() => []);
  };
  return { catalog, modelCatalog, reset, setRecords, setRoot };
}

export function retainedCatalogRecords(
  count: number,
  contentHash: string,
  size: number,
  embeddingSetId: string
): NativeCanonicalCatalogRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    chunksProcessed: false,
    content: null,
    contentHash,
    embeddingSetId,
    fileId: `retained-${index}`,
    fileName: `retained-${index}.txt`,
    path: null,
    rootId: null,
    stat: { mtimeMs: 1, size },
  }));
}
