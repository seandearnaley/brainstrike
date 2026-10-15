// @vitest-environment node
import { describe, expect, it } from 'vitest';

// Import types to verify they compile correctly
import type {
  ChunkSearchResult,
  EnhancedImportProgress,
  EnhancedImportResult,
  ExportHandlers,
  ImportSettings,
  SearchFunctionality,
} from '../index';

describe('types module', () => {
  it('ChunkSearchResult type can be used correctly', () => {
    const result: ChunkSearchResult = {
      chunk: {
        chunkIndex: 0,
        content: 'test content',
        contentHash: 'hash123',
        fileRecordId: 'file-1',
        id: '1',
        tokenCount: 10,
      } as ChunkSearchResult['chunk'],
      fileRecord: {
        createdAt: '2024-01-01',
        id: 'file-1',
        name: 'test.txt',
        path: '/path/test.txt',
        size: 100,
        updatedAt: '2024-01-01',
      } as ChunkSearchResult['fileRecord'],
      similarity: 0.9,
    };
    expect(result.similarity).toBe(0.9);
  });

  it('EnhancedImportResult type can be used correctly', () => {
    const result: EnhancedImportResult = {
      chunksCreated: 5,
      existed: false,
      id: '1',
      imported: true,
    };
    expect(result.imported).toBe(true);
  });

  it('EnhancedImportResult type supports optional fields', () => {
    const result: EnhancedImportResult = {
      chunkingStrategy: 'sentence',
      chunksCreated: 0,
      chunksWithEmbeddings: 0,
      error: 'File already exists',
      existed: true,
      id: '2',
      imported: false,
    };
    expect(result.error).toBe('File already exists');
  });

  it('EnhancedImportProgress type extends ImportProgress', () => {
    // EnhancedImportProgress extends ImportProgress with additional phase info
    const progress: EnhancedImportProgress = {
      completed: 10,
      errors: [],
      phase: 'complete',
      total: 10,
    };
    expect(progress.phase).toBe('complete');
    expect(progress.total).toBe(10);
    expect(progress.completed).toBe(10);
  });

  it('EnhancedImportProgress type supports queueProgress', () => {
    const progress: EnhancedImportProgress = {
      completed: 10,
      errors: [],
      phase: 'embedding',
      queueProgress: {
        failed: 1,
        lastError: null,
        pending: 5,
        processed: 20,
        totalQueued: 26,
      },
      total: 10,
    };
    expect(progress.queueProgress?.processed).toBe(20);
  });

  it('ImportSettings type has all required properties', () => {
    const settings: ImportSettings = {
      chunkingPreset: 'balanced',
      // BST-423: hydration-repair notice + its dismissal are part of the shape,
      // so every construction site is forced to acknowledge them.
      chunkingSettingsRepairs: [],
      chunkingStrategy: 'auto',
      chunkingStrategyExplicit: false,
      chunkOverlap: 50,
      chunkSize: 500,
      chunkTokenLimit: 8192,
      dismissChunkingSettingsRepairs: () => {},
      enableChunking: true,
      setChunkingPreset: () => {},
      setChunkingStrategy: () => {},
      setChunkOverlap: () => {},
      setChunkSize: () => {},
      setChunkTokenLimit: () => {},
      setEnableChunking: () => {},
      setTokenTrueSizing: () => {},
      tokenTrueSizing: true,
    };
    expect(settings.enableChunking).toBe(true);
    expect(settings.chunkingStrategy).toBe('auto');
  });

  it('ExportHandlers type has all required methods', () => {
    const handlers: ExportHandlers = {
      handleExportAll: async () => {},
      handleExportChunks: async () => {},
      handleExportEmbeddings: async () => {},
      handleExportFiles: async () => {},
    };
    expect(typeof handlers.handleExportFiles).toBe('function');
    expect(typeof handlers.handleExportAll).toBe('function');
  });

  it('SearchFunctionality type has all required properties', () => {
    const search: SearchFunctionality = {
      handleSearch: async () => {},
      hasSearched: false,
      searching: false,
      searchQuery: 'test query',
      searchResults: [],
      searchThreshold: 0.5,
      setSearchQuery: () => {},
      setSearchThreshold: () => {},
    };
    expect(search.searchQuery).toBe('test query');
    expect(search.searching).toBe(false);
  });
});
