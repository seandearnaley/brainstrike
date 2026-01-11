export interface FileRecord {
  id: string; // UUID
  name: string;
  path: string;
  size: number;
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
  content?: string; // File content (for text files)
  contentHash?: string; // Hash of content for deduplication
  tokenCount?: number; // Number of tokens in content
  processedAt?: string; // ISO date when file was processed/imported
  embedding?: number[]; // Vector embedding for semantic search
  chunksProcessedAt?: string; // ISO date when file was chunked
  chunksCount?: number; // Number of chunks created for this file
  chunkingStrategy?: 'sentence' | 'token' | 'recursive'; // Strategy used for chunking
  embeddingSetId?: string; // Collection this file belongs to (set at import time)
}

export interface FileImportRequest {
  path: string;
  name: string;
  content: string;
  size: number;
  embeddingSetId?: string; // Collection this file belongs to (set at import time)
}

export interface FileImportResult {
  id: string;
  imported: boolean;
  existed: boolean;
  error?: string;
}

export interface ImportProgress {
  total: number;
  completed: number;
  current?: string;
  errors: Array<{ file: string; error: string }>;
}
