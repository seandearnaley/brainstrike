import type { IndexerResult } from './background-indexer.worker';
import type { TokenCacheStore } from './token-cache-store';
import type { TokenCacheEntry } from './types';

export async function persistResultToStore(
  result: IndexerResult,
  store: Pick<TokenCacheStore, 'get' | 'getBatch' | 'set'>,
  onFileIndexed?: (compositeKey: string, tokenCount: number, fileSize: number) => void
): Promise<void> {
  if (result.skipped) {
    const cached = await store.get(result.folderId, result.filePath);
    if (cached) {
      onFileIndexed?.(result.compositeKey, cached.tokenCount, cached.fileSize);
    }
    return;
  }

  const entry: TokenCacheEntry = {
    contentHash: result.contentHash,
    countingMode: result.mode,
    filePath: result.filePath,
    fileSize: result.fileSize,
    folderId: result.folderId,
    modelEncoding: result.mode === 'accurate' ? 'o200k_base' : null,
    mtimeMs: null,
    tokenCount: result.tokenCount,
  };

  await store.set(entry);
  onFileIndexed?.(result.compositeKey, result.tokenCount, entry.fileSize);
}
