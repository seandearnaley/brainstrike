/**
 * Status information for a file in relation to an embedding set (collection)
 */
export interface FileCollectionStatus {
  /** File record ID */
  fileId: string;
  /** File name */
  fileName: string;
  /** File path */
  filePath: string;
  /** Last time file was indexed in any collection */
  lastIndexedAt?: string;
  /** Number of other collections this file is searchable in */
  otherCollectionsCount: number;
  /** Number of chunks with embeddings in active collection */
  searchableChunksCount: number;
  /** Whether file is searchable in the active collection (has embeddings) */
  searchableInActive: boolean;
  /** Total number of chunks for this file */
  totalChunksCount: number;
}
