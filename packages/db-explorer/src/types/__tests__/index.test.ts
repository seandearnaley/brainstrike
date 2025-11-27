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
        id: '1',
        fileRecordId: 'file-1',
        chunkIndex: 0,
        content: 'test content',
        contentHash: 'hash123',
        tokenCount: 10,
      } as ChunkSearchResult['chunk'],
      similarity: 0.9,
      fileRecord: {
        id: 'file-1',
        name: 'test.txt',
        path: '/path/test.txt',
        size: 100,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      } as ChunkSearchResult['fileRecord'],
    };
    expect(result.similarity).toBe(0.9);
  });

  it('EnhancedImportResult type can be used correctly', () => {
    const result: EnhancedImportResult = {
      id: '1',
      imported: true,
      existed: false,
      chunksCreated: 5,
    };
    expect(result.imported).toBe(true);
  });

  it('EnhancedImportResult type supports optional fields', () => {
    const result: EnhancedImportResult = {
      id: '2',
      imported: false,
      existed: true,
      error: 'File already exists',
      chunksCreated: 0,
      chunksWithEmbeddings: 0,
      chunkingStrategy: 'sentence',
    };
    expect(result.error).toBe('File already exists');
  });

  it('EnhancedImportProgress type extends ImportProgress', () => {
    // EnhancedImportProgress extends ImportProgress with additional phase info
    const progress: EnhancedImportProgress = {
      phase: 'complete',
      total: 10,
      completed: 10,
      errors: [],
    };
    expect(progress.phase).toBe('complete');
    expect(progress.total).toBe(10);
    expect(progress.completed).toBe(10);
  });

  it('EnhancedImportProgress type supports queueProgress', () => {
    const progress: EnhancedImportProgress = {
      phase: 'embedding',
      total: 10,
      completed: 10,
      errors: [],
      queueProgress: {
        pending: 5,
        processed: 20,
        failed: 1,
        totalQueued: 26,
        lastError: null,
      },
    };
    expect(progress.queueProgress?.processed).toBe(20);
  });

  it('ImportSettings type has all required properties', () => {
    const settings: ImportSettings = {
      enableChunking: true,
      setEnableChunking: () => {},
      chunkingStrategy: 'sentence',
      setChunkingStrategy: () => {},
      chunkingStrategyExplicit: false,
      chunkSize: 500,
      setChunkSize: () => {},
      chunkOverlap: 50,
      setChunkOverlap: () => {},
      tokenTrueSizing: true,
      setTokenTrueSizing: () => {},
      chunkTokenLimit: 8192,
      setChunkTokenLimit: () => {},
    };
    expect(settings.enableChunking).toBe(true);
    expect(settings.chunkingStrategy).toBe('sentence');
  });

  it('ExportHandlers type has all required methods', () => {
    const handlers: ExportHandlers = {
      handleExportFiles: () => {},
      handleExportChunks: () => {},
      handleExportEmbeddings: () => {},
      handleExportAll: async () => {},
    };
    expect(typeof handlers.handleExportFiles).toBe('function');
    expect(typeof handlers.handleExportAll).toBe('function');
  });

  it('SearchFunctionality type has all required properties', () => {
    const search: SearchFunctionality = {
      searchQuery: 'test query',
      setSearchQuery: () => {},
      searchResults: [],
      searching: false,
      searchThreshold: 0.5,
      setSearchThreshold: () => {},
      handleSearch: async () => {},
      hasSearched: false,
    };
    expect(search.searchQuery).toBe('test query');
    expect(search.searching).toBe(false);
  });
});
