import type { ChunkingStrategy, FileChunk, FileRecord, ImportProgress } from '@brainstrike/db';

export type ChunkSearchResult = {
  chunk: FileChunk;
  similarity: number;
  fileRecord: FileRecord;
};

export type EnhancedImportResult = {
  id: string;
  imported: boolean;
  existed: boolean;
  error?: string;
  chunksCreated: number;
  chunksWithEmbeddings?: number;
  chunkingStrategy?: ChunkingStrategy;
};

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

export type ImportProgressDisplayProps = {
  progress: EnhancedImportProgress;
  onClose: () => void;
};

export type SettingsPanelProps = {
  importSettings: ImportSettings;
  onFactoryReset?: (() => Promise<void>) | undefined;
};

export type ExportButtonsProps = {
  records: FileRecord[];
  chunks: FileChunk[];
  exportHandlers: ExportHandlers;
};

export type ImportSettings = {
  enableChunking: boolean;
  setEnableChunking: (value: boolean) => void;
  chunkingStrategy: ChunkingStrategy;
  setChunkingStrategy: (value: ChunkingStrategy) => void;
  chunkingStrategyExplicit: boolean;
  chunkSize: number;
  setChunkSize: (value: number) => void;
  chunkOverlap: number;
  setChunkOverlap: (value: number) => void;
  tokenTrueSizing: boolean;
  setTokenTrueSizing: (value: boolean) => void;
  chunkTokenLimit: number;
  setChunkTokenLimit: (value: number) => void;
};

export type ExportHandlers = {
  handleExportFiles: () => void;
  handleExportChunks: () => void;
  handleExportEmbeddings: () => void;
  handleExportAll: () => Promise<void>;
};

export type SearchFunctionality = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: ChunkSearchResult[];
  searching: boolean;
  searchThreshold: number;
  setSearchThreshold: (threshold: number) => void;
  handleSearch: () => Promise<void>;
  hasSearched: boolean;
};
