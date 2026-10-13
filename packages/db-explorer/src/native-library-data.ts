import type { SourceChunkPage, SourceFilesCapability } from '@brainstrike/assistant-contract';
/** No search limits or approximate result sets: export consumes every exact, identity-checked page. */
export async function readNativeFileChunks(
  capability: Pick<SourceFilesCapability, 'chunks'>,
  fileId: string,
  contentHash?: string
): Promise<SourceChunkPage['chunks']> {
  const result: SourceChunkPage['chunks'][number][] = [];
  let offset = 0;
  let expected:
    | { contentHash: string; snapshotHash: string; profileHash: string | null }
    | undefined;
  let total: number | undefined;
  while (true) {
    const page = await capability.chunks({
      fileId,
      limit: 100,
      offset,
      ...(expected ? { expected } : {}),
    });
    if (page.kind === 'unavailable') {
      throw new Error(page.reason);
    }
    if (
      page.fileId !== fileId ||
      (contentHash !== undefined && page.contentHash !== contentHash) ||
      (expected &&
        (expected.contentHash !== page.contentHash ||
          expected.snapshotHash !== page.snapshotHash ||
          expected.profileHash !== page.profileHash)) ||
      (total !== undefined && total !== page.total)
    ) {
      throw new Error(
        'The Library source or index profile changed during export. Refresh before trying again.'
      );
    }
    expected = {
      contentHash: page.contentHash,
      profileHash: page.profileHash,
      snapshotHash: page.snapshotHash,
    };
    total = page.total;
    result.push(...page.chunks);
    if (page.nextOffset === null) {
      if (result.length !== page.total) {
        throw new Error('Native Library export did not return every chunk.');
      }
      return result;
    }
    if (page.nextOffset <= offset || page.nextOffset !== result.length) {
      throw new Error('Native Library page did not advance contiguously.');
    }
    offset = page.nextOffset;
  }
}
