import type { ChunkingSettingsRepair } from '@brainstrike/app-state/stores/import-settings-store';
import type { ImportProgress } from '@brainstrike/db';
import type { ChunkingPresetSelection, ChunkingStrategy } from '@brainstrike/text-splitter';

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

export interface SettingsPanelProps {
  className?: string;
  importSettings: ImportSettings;
  onFactoryReset?: (() => Promise<void>) | undefined;
}

export interface ImportSettings {
  chunkingPreset: ChunkingPresetSelection;
  /** BST-423: persisted values replaced at hydration because they were impossible. */
  chunkingSettingsRepairs: readonly ChunkingSettingsRepair[];
  chunkingStrategy: ChunkingStrategy;
  chunkingStrategyExplicit: boolean;
  chunkOverlap: number;
  chunkSize: number;
  chunkTokenLimit: number;
  dismissChunkingSettingsRepairs: () => void;
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
