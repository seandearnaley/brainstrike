import type { ChunkingStrategy } from '@brainstrike/db';
import type { ImportProgress } from '@brainstrike/ui';

export interface EnhancedImportProgress extends ImportProgress {
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
  phase: 'importing' | 'chunking' | 'embedding' | 'complete';
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
  chunkingStrategy?: ChunkingStrategy;
  chunksCreated: number;
  chunksWithEmbeddings?: number;
  error?: string;
  existed: boolean;
  id: string;
  imported: boolean;
}
