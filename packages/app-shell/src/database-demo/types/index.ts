import type { ChunkingStrategy, FileChunk, FileRecord, ImportProgress } from '@brainstrike/db';

export interface ChunkSearchResult {
  chunk: FileChunk;
  similarity: number;
  fileRecord: FileRecord;
}

export interface ViewSelectorProps {
  selectedView: 'files' | 'chunks' | 'search';
  setSelectedView: (view: 'files' | 'chunks' | 'search') => void;
  recordsCount: number;
  chunksCount: number;
}

export interface DbInfoDisplayProps {
  dbInfo: {
    location: string;
    testResult: string;
    connected: boolean;
  } | null;
}

export interface EnhancedImportResult {
  id: string;
  imported: boolean;
  existed: boolean;
  error?: string;
  chunksCreated: number;
  chunksWithEmbeddings?: number;
}

export interface EnhancedImportProgress extends ImportProgress {
  phase: 'importing' | 'chunking' | 'embedding' | 'complete';
  chunkingProgress?: {
    filesProcessed: number;
    totalFiles: number;
    currentFile?: string | undefined;
    chunksCreated: number;
  };
  embeddingProgress?: {
    chunksProcessed: number;
    totalChunks: number;
    currentChunk?: string | undefined;
    modelName: string;
  };
}

export interface ImportProgressDisplayProps {
  progress: EnhancedImportProgress;
  onClose: () => void;
}

export interface SettingsPanelProps {
  importSettings: ImportSettings;
}

export interface ExportButtonsProps {
  records: FileRecord[];
  chunks: FileChunk[];
  exportHandlers: ExportHandlers;
}

export interface SearchInterfaceProps {
  searchFunctionality: SearchFunctionality;
}

export interface ImportSettings {
  enableChunking: boolean;
  setEnableChunking: (value: boolean) => void;
  chunkingStrategy: ChunkingStrategy;
  setChunkingStrategy: (value: ChunkingStrategy) => void;
  chunkSize: number;
  setChunkSize: (value: number) => void;
  chunkOverlap: number;
  setChunkOverlap: (value: number) => void;
  enableEmbedding: boolean;
  setEnableEmbedding: (value: boolean) => void;
  selectedModel: string;
  setSelectedModel: (value: string) => void;
}

export interface ExportHandlers {
  handleExportFiles: () => void;
  handleExportChunks: () => void;
  handleExportEmbeddings: () => void;
  handleExportAll: () => Promise<void>;
}

export interface SearchFunctionality {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: ChunkSearchResult[];
  searching: boolean;
  searchThreshold: number;
  setSearchThreshold: (threshold: number) => void;
  handleSearch: () => Promise<void>;
  hasSearched: boolean;
}
