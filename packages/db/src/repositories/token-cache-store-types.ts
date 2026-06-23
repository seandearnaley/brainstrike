export type TokenCountingMode = 'accurate' | 'heuristic';

export interface TokenCacheEntry {
  contentHash: string;
  countingMode: TokenCountingMode;
  createdAt: string;
  filePath: string;
  fileSize: number;
  folderId: string;
  modelEncoding: string | null;
  mtimeMs: number | null;
  tokenCount: number;
  updatedAt: string;
}

export interface TokenCacheStats {
  accurateCount: number;
  entryCount: number;
  heuristicCount: number;
  totalTokens: number;
}
