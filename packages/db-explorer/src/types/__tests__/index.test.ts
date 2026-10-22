// @vitest-environment node
import { describe, expect, it } from 'vitest';

// Import types to verify they compile correctly
import type { EnhancedImportProgress, EnhancedImportResult, ImportSettings } from '../index';

describe('types module', () => {
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
});
