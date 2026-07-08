import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnhancedImportResult } from '../types';
import { useImportFlow } from '../use-import-flow';

const importServiceReturn = {
  chunkRepository: { findAll: vi.fn() },
  importFiles: vi.fn().mockResolvedValue(undefined),
  isImporting: false,
  progress: null,
};

let latestOptions: {
  onComplete?: (results: EnhancedImportResult[]) => Promise<void> | void;
  onProgress?: () => void;
  tokenTrueSizing?: boolean;
  chunkTokenLimit?: number;
  resolveTargetEmbeddingSetId?: () => string | null;
};
let selectionPaths = new Set<string>();

vi.mock('../enhanced-file-import-service', () => ({
  useEnhancedFileImportService: (options: typeof latestOptions) => {
    latestOptions = options;
    return importServiceReturn;
  },
}));

const mockExplorer: {
  fileContents: Record<string, string>;
  fileTree: Record<string, unknown>[];
  unfilteredFileTree: Record<string, unknown>[] | null;
} = {
  fileContents: { '/file.txt': 'contents' },
  fileTree: [],
  unfilteredFileTree: null,
};

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorer: () => mockExplorer,
  useSelectionManager: () => ({ selectedFilePaths: selectionPaths }),
}));

const baseSettings = {
  chunkingStrategy: 'sentence' as const,
  chunkingStrategyExplicit: false,
  chunkOverlap: 0,
  chunkSize: 512,
  chunkTokenLimit: 4096,
  enableChunking: true,
  tokenTrueSizing: true,
};

beforeEach(() => {
  selectionPaths = new Set();
  importServiceReturn.importFiles.mockClear();
  importServiceReturn.chunkRepository = { findAll: vi.fn() };
  importServiceReturn.progress = null;
  latestOptions = {};
  mockExplorer.fileTree = [];
  mockExplorer.unfilteredFileTree = null;
});

describe('useImportFlow', () => {
  it('notifies the user when no files are selected', () => {
    const toast = vi.fn();

    const { result } = renderHook(() =>
      useImportFlow({
        importSettings: baseSettings,
        resolveActiveCollectionId: () => 'set-1',
        toast,
      })
    );

    act(() => {
      result.current.handleImportClick();
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(importServiceReturn.importFiles).not.toHaveBeenCalled();
  });

  it('imports selected files when available', async () => {
    const toast = vi.fn();
    selectionPaths = new Set(['/file.txt']);
    mockExplorer.fileTree = [{ id: 'filtered-file-node' }];

    const { result } = renderHook(() =>
      useImportFlow({
        importSettings: baseSettings,
        resolveActiveCollectionId: () => 'set-1',
        toast,
      })
    );

    await act(async () => {
      result.current.handleImportClick();
      await Promise.resolve();
    });

    expect(importServiceReturn.importFiles).toHaveBeenCalledWith(
      selectionPaths,
      mockExplorer.fileTree,
      mockExplorer.fileContents
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it('uses the unfiltered file tree for import resolution when available', async () => {
    const toast = vi.fn();
    selectionPaths = new Set(['/file.txt']);
    mockExplorer.fileTree = [];
    mockExplorer.unfilteredFileTree = [{ id: 'canonical-file-node', path: '/file.txt' }];

    const { result } = renderHook(() =>
      useImportFlow({
        importSettings: baseSettings,
        resolveActiveCollectionId: () => 'set-1',
        toast,
      })
    );

    await act(async () => {
      result.current.handleImportClick();
      await Promise.resolve();
    });

    expect(importServiceReturn.importFiles).toHaveBeenCalledWith(
      selectionPaths,
      mockExplorer.unfilteredFileTree,
      mockExplorer.fileContents
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it('invokes completion and progress handlers from the import service', async () => {
    const toast = vi.fn();
    const onImportComplete = vi.fn();
    const onChunkRepositoryChange = vi.fn();

    const { result } = renderHook(() =>
      useImportFlow({
        importSettings: baseSettings,
        onChunkRepositoryChange,
        onImportComplete,
        resolveActiveCollectionId: () => 'set-1',
        toast,
      })
    );

    await act(async () => {
      latestOptions.onProgress?.();
      await latestOptions.onComplete?.([
        { chunksCreated: 1, existed: false, id: '1', imported: true } as EnhancedImportResult,
      ]);
      await Promise.resolve();
    });

    expect(result.current.showImportProgress).toBe(true);
    expect(onImportComplete).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setShowImportProgress(false);
    });

    expect(result.current.showImportProgress).toBe(false);
    expect(onChunkRepositoryChange).toHaveBeenCalledWith(importServiceReturn.chunkRepository!);
  });

  it('uses the latest completion handler without waiting for an effect tick', async () => {
    const toast = vi.fn();
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();

    const { rerender } = renderHook(
      ({ onImportComplete }: { onImportComplete?: (results: EnhancedImportResult[]) => void }) =>
        useImportFlow({
          importSettings: baseSettings,
          resolveActiveCollectionId: () => 'set-1',
          toast,
          ...(onImportComplete ? { onImportComplete } : {}),
        }),
      {
        initialProps: { onImportComplete: firstComplete },
      }
    );

    rerender({ onImportComplete: secondComplete });

    await act(async () => {
      await latestOptions.onComplete?.([
        { chunksCreated: 1, existed: false, id: '1', imported: true } as EnhancedImportResult,
      ]);
    });

    expect(firstComplete).not.toHaveBeenCalled();
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });

  it('forwards tokenTrueSizing preference to the enhanced import service', () => {
    const toast = vi.fn();
    renderHook(() =>
      useImportFlow({
        importSettings: { ...baseSettings, chunkTokenLimit: 8192, tokenTrueSizing: false },
        resolveActiveCollectionId: () => 'set-1',
        toast,
      })
    );

    expect(latestOptions).toEqual(
      expect.objectContaining({ chunkTokenLimit: 8192, tokenTrueSizing: false })
    );
  });

  it('prevents imports when no collection is selected', async () => {
    const toast = vi.fn();
    selectionPaths = new Set(['/file.txt']);
    const resolver = vi.fn(() => null);

    const { result } = renderHook(() =>
      useImportFlow({ importSettings: baseSettings, resolveActiveCollectionId: resolver, toast })
    );

    await act(async () => {
      result.current.handleImportClick();
      await Promise.resolve();
    });

    expect(resolver).toHaveBeenCalled();
    expect(importServiceReturn.importFiles).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Select a Collection' }));
  });
});
