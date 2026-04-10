import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviewPanelState } from '../use-preview-panel-state';
import type { TokenCountingState } from '../use-token-counting';

const { mockUsePersistentTokenCache } = vi.hoisted(() => ({
  mockUsePersistentTokenCache: vi.fn(() => ({
    cacheVersion: 0,
    getFileSize: () => undefined,
    getTokenCount: () => undefined,
    isAnyLoading: false,
    pendingRequestsRef: { current: new Map() },
    tokenCacheRef: { current: new Map() },
    getCachedSelectionStats: vi.fn(async () => ({ cachedFileCount: 0, totalTokens: 0 })),
  })),
}));

vi.mock('../use-persistent-token-cache', () => ({
  usePersistentTokenCache: mockUsePersistentTokenCache,
}));

const tokenCounting: TokenCountingState = {
  countTokens: async () => 0,
  loading: false,
  mode: 'heuristic',
  reason: null,
};

describe('usePreviewPanelState path sorting', () => {
  beforeEach(() => {
    mockUsePersistentTokenCache.mockReset();
    mockUsePersistentTokenCache.mockReturnValue({
      cacheVersion: 0,
      getFileSize: () => undefined,
      getTokenCount: () => undefined,
      isAnyLoading: false,
      pendingRequestsRef: { current: new Map() },
      tokenCacheRef: { current: new Map() },
      getCachedSelectionStats: vi.fn(async () => ({ cachedFileCount: 0, totalTokens: 0 })),
    });
  });

  it('preserves default localeCompare ordering for numeric substrings', () => {
    const selectedFiles = new Set<string>([
      'folder::src/file2.ts',
      'folder::src/file10.ts',
      'folder::src/file1.ts',
    ]);

    const { result } = renderHook(() =>
      usePreviewPanelState({
        selectedFiles,
        fileContents: {},
        loadingFiles: new Set<string>(),
        onSelectionChange: vi.fn(),
        fileSizes: {},
        decodeFileSelection: (compositeKey: string) => {
          const [folderId = '', path = ''] = compositeKey.split('::');
          return { folderId, path };
        },
        tokenCounting,
        performUndoableAction: vi.fn(),
      })
    );

    const fileItems = result.current.flatListItems.filter((item) => item.type === 'file') as Array<{
      path: string;
      type: 'file';
    }>;

    // Default Intl.Collator (no `numeric: true`) uses lexicographic order,
    // so "file10" sorts before "file2" because '1' < '2'.
    expect(fileItems.map((item) => item.path)).toEqual([
      'src/file1.ts',
      'src/file10.ts',
      'src/file2.ts',
    ]);
  });

  it('hydrates totalStats from cached selection stats when selected files were previously indexed', async () => {
    const selectedFiles = new Set<string>(['folder::src/index.ts', 'folder::src/utils.ts']);
    const getCachedSelectionStats = vi.fn(async () => ({
      cachedFileCount: 2,
      totalTokens: 420,
    }));

    mockUsePersistentTokenCache.mockReturnValue({
      cacheVersion: 0,
      getFileSize: () => undefined,
      getTokenCount: () => undefined,
      getCachedSelectionStats,
      isAnyLoading: false,
      pendingRequestsRef: { current: new Map() },
      tokenCacheRef: { current: new Map() },
    });

    const { result } = renderHook(() =>
      usePreviewPanelState({
        selectedFiles,
        fileContents: {},
        loadingFiles: new Set<string>(),
        onSelectionChange: vi.fn(),
        fileSizes: {},
        decodeFileSelection: (compositeKey: string) => {
          const [folderId = '', path = ''] = compositeKey.split('::');
          return { folderId, path };
        },
        tokenCounting,
        performUndoableAction: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.totalStats).toEqual({
        pendingCount: 0,
        totalFiles: 2,
        totalTokens: 420,
      });
    });

    expect(getCachedSelectionStats).toHaveBeenCalledWith(selectedFiles);
  });
});
