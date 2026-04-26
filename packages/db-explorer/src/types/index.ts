import type { FileChunk, FileRecord, ImportProgress } from '@brainstrike/db';
import type { ChunkingPresetSelection, ChunkingStrategy } from '@brainstrike/text-splitter';

export interface ChunkSearchResult {
  chunk: FileChunk;
  fileRecord: FileRecord;
  similarity: number;
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

export interface ImportProgressDisplayProps {
  onClose: () => void;
  progress: EnhancedImportProgress;
}

export interface SettingsPanelProps {
  className?: string;
  importSettings: ImportSettings;
  onFactoryReset?: (() => Promise<void>) | undefined;
}

export interface ExportButtonsProps {
  counts: {
    chunks: number;
    embeddings: number;
    records: number;
  };
  countsStatus?: 'pending' | 'ready';
  exportHandlers: ExportHandlers;
}

export interface ImportSettings {
  chunkingPreset: ChunkingPresetSelection;
  chunkingStrategy: ChunkingStrategy;
  chunkingStrategyExplicit: boolean;
  chunkOverlap: number;
  chunkSize: number;
  chunkTokenLimit: number;
  enableChunking: boolean;
  setChunkingPreset: (value: ChunkingPresetSelection) => void;
  setChunkingStrategy: (value: ChunkingStrategy) => void;
  setChunkOverlap: (value: number) => void;
  setChunkSize: (value: number) => void;
  setChunkTokenLimit: (value: number) => void;
  setEnableChunking: (value: boolean) => void;
  setTokenTrueSizing: (value: boolean) => void;
  tokenTrueSizing: boolean;
}

export interface ExportHandlers {
  handleExportAll: () => Promise<void>;
  handleExportChunks: () => Promise<void>;
  handleExportEmbeddings: () => Promise<void>;
  handleExportFiles: () => Promise<void>;
}

export interface SearchFunctionality {
  handleSearch: () => Promise<void>;
  hasSearched: boolean;
  searching: boolean;
  searchQuery: string;
  searchResults: ChunkSearchResult[];
  searchThreshold: number;
  setSearchQuery: (query: string) => void;
  setSearchThreshold: (threshold: number) => void;
}
