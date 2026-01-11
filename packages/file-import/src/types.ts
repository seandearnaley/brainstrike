import type { ChunkingStrategy } from '@brainstrike/db';
import type { ImportProgress } from '@brainstrike/ui';

export interface EnhancedImportProgress extends ImportProgress {
  phase: 'importing' | 'chunking' | 'embedding' | 'complete';
  chunkingProgress?: {
    filesProcessed: number;
    totalFiles: number;
    currentFile?: string | undefined;
    chunksCreated: number;
    strategyUsed?: ChunkingStrategy;
  };
  embeddingProgress?: {
    chunksProcessed: number;
    totalChunks: number;
    currentChunk?: string | undefined;
    modelName: string;
  };
  queueProgress?: {
    pending: number;
    processed: number;
    failed: number;
    totalQueued: number;
    lastError: string | null;
    lastEvent?: {
      chunkId: string;
      status: 'queued' | 'completed' | 'error';
      model: string;
      elapsedMs?: number;
      errorMessage?: string;
    };
  };
}

export interface EnhancedImportResult {
  id: string;
  imported: boolean;
  existed: boolean;
  error?: string;
  chunksCreated: number;
  chunksWithEmbeddings?: number;
  chunkingStrategy?: ChunkingStrategy;
}
