import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import type { SourceCatalogPort } from '@brainstrike/state-store';
import type { NativeSearchAuthority } from './native-scoped-search';

interface LibraryRead {
  getAuthority(): Promise<Pick<NativeSearchAuthority, 'bindings'>>;
  readonly port: Pick<ScopedIndexerPort, 'readScopedFilePage'>;
}

interface Dependencies {
  readonly catalog: SourceCatalogPort;
  readonly withRead: <T>(work: (read: LibraryRead) => Promise<T>) => Promise<T>;
}
/** Pages use the admitted native reader; listing/imported bytes remain the canonical catalog's facts. */
export function createSourceChunkReader({
  catalog,
  withRead,
}: Dependencies): SourceFilesCapability['chunks'] {
  return async (request) => {
    const file = (await catalog.sourceCatalog({ fileIds: [request.fileId], operation: 'read' }))
      .files[0];
    if (!file || file.fileId !== request.fileId) {
      throw new Error('The requested Library source no longer exists.');
    }
    if (request.expected && request.expected.contentHash !== file.contentHash) {
      throw new Error('The Library source changed during export. Refresh it before trying again.');
    }
    return await withRead(async (read) => {
      const authority = await read.getAuthority();
      const binding = authority.bindings.find((value) => value.fileId === file.fileId);
      if (!binding) {
        return {
          kind: 'unavailable',
          reason:
            'This file is outside the active native index. Select its collection and reconnect its folder to read chunks.',
        };
      }
      const scope =
        binding.rootId === null
          ? binding.embeddingSetId === null
            ? null
            : { embeddingSetId: binding.embeddingSetId, kind: 'collection' as const }
          : { kind: 'workspace' as const, rootId: binding.rootId };
      if (!scope) {
        return {
          kind: 'unavailable',
          reason: 'Assign this imported file to a collection before reading chunks.',
        };
      }
      const page = await read.port.readScopedFilePage({
        contentHash: file.contentHash,
        fileId: file.fileId,
        limit: request.limit,
        offset: request.offset,
        scope,
        ...(request.expected
          ? {
              profileHash: request.expected.profileHash,
              snapshotHash: request.expected.snapshotHash,
            }
          : {}),
      });
      await read.getAuthority();
      return { kind: 'available', ...page };
    });
  };
}
