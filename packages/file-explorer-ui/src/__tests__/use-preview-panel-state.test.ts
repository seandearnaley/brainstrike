import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsePersistentTokenCacheReturn } from '../indexing/use-persistent-token-cache';
import type { TokenCountingState } from '../indexing/use-token-counting';
import { usePreviewPanelState } from '../preview/use-preview-panel-state';

type CachedSelectionStats = Awaited<
  ReturnType<UsePersistentTokenCacheReturn['getCachedSelectionStats']>
>;

function createPersistentTokenCacheMock(
  overrides: Partial<UsePersistentTokenCacheReturn> = {}
): UsePersistentTokenCacheReturn {
  return {
    cacheVersion: 0,
    getCachedSelectionStats: vi.fn(
      async (): Promise<CachedSelectionStats> => ({
        cachedFileCount: 0,
        tokenCounts: new Map<string, number>(),
        totalTokens: 0,
      })
    ),
    getFileSize: (_compositeKey: string) => undefined,
    getTokenCount: (_compositeKey: string) => undefined,
    isAnyLoading: false,
    pendingRequestsRef: { current: new Map() },
    tokenCacheRef: { current: new Map() },
    ...overrides,
  };
}

const { mockUsePersistentTokenCache } = vi.hoisted(() => ({
  mockUsePersistentTokenCache: vi.fn(),
}));

vi.mock('../indexing/use-persistent-token-cache', () => ({
  usePersistentTokenCache: mockUsePersistentTokenCache,
}));

const tokenCounting: TokenCountingState = {
  countTokens: async () => 0,
  loading: false,
  mode: 'heuristic',
  reason: null,
};

const decodeFileSelection = (compositeKey: string) => {
  const [folderId = '', path = ''] = compositeKey.split('::');
  return { folderId, path };
};

describe('usePreviewPanelState path sorting', () => {
  beforeEach(() => {
    mockUsePersistentTokenCache.mockReset();
    mockUsePersistentTokenCache.mockReturnValue(createPersistentTokenCacheMock());
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
        decodeFileSelection,
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
      tokenCounts: new Map([
        ['folder::src/index.ts', 210],
        ['folder::src/utils.ts', 210],
      ]),
      totalTokens: 420,
    }));

    mockUsePersistentTokenCache.mockReturnValue(
      createPersistentTokenCacheMock({
        getCachedSelectionStats,
      })
    );

    const { result } = renderHook(() =>
      usePreviewPanelState({
        selectedFiles,
        fileContents: {},
        loadingFiles: new Set<string>(),
        onSelectionChange: vi.fn(),
        fileSizes: {},
        decodeFileSelection,
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

  it('merges hot-cache and persisted-cache token counts per file for the current selection', async () => {
    const selectedFiles = new Set<string>(['folder::src/index.ts', 'folder::src/utils.ts']);
    const getCachedSelectionStats = vi.fn(async () => ({
      cachedFileCount: 1,
      tokenCounts: new Map([['folder::src/utils.ts', 200]]),
      totalTokens: 200,
    }));

    mockUsePersistentTokenCache.mockReturnValue(
      createPersistentTokenCacheMock({
        getCachedSelectionStats,
        getTokenCount: (compositeKey: string) =>
          compositeKey === 'folder::src/index.ts' ? 50 : undefined,
      })
    );

    const { result } = renderHook(() =>
      usePreviewPanelState({
        selectedFiles,
        fileContents: {},
        loadingFiles: new Set<string>(),
        onSelectionChange: vi.fn(),
        fileSizes: {},
        decodeFileSelection,
        tokenCounting,
        performUndoableAction: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.totalStats).toEqual({
        pendingCount: 0,
        totalFiles: 2,
        totalTokens: 250,
      });
    });
  });

  it('ignores cached totals from the previous selection while the next cached snapshot is still loading', async () => {
    let resolveCachedSelection!: (value: CachedSelectionStats) => void;
    const getCachedSelectionStats = vi.fn(
      () =>
        new Promise<CachedSelectionStats>((resolve) => {
          resolveCachedSelection = resolve;
        })
    );

    mockUsePersistentTokenCache.mockReturnValue(
      createPersistentTokenCacheMock({
        getCachedSelectionStats,
      })
    );

    const { result, rerender } = renderHook(
      ({ selectedFiles }: { selectedFiles: Set<string> }) =>
        usePreviewPanelState({
          selectedFiles,
          fileContents: {},
          loadingFiles: new Set<string>(),
          onSelectionChange: vi.fn(),
          fileSizes: {},
          decodeFileSelection,
          tokenCounting,
          performUndoableAction: vi.fn(),
        }),
      {
        initialProps: {
          selectedFiles: new Set<string>(['folder::src/large.ts']),
        },
      }
    );

    resolveCachedSelection({
      cachedFileCount: 1,
      tokenCounts: new Map([['folder::src/large.ts', 600]]),
      totalTokens: 600,
    });

    await waitFor(() => {
      expect(result.current.totalStats).toEqual({
        pendingCount: 0,
        totalFiles: 1,
        totalTokens: 600,
      });
    });

    rerender({
      selectedFiles: new Set<string>(['folder::src/small.ts']),
    });

    expect(result.current.totalStats).toEqual({
      pendingCount: 1,
      totalFiles: 1,
      totalTokens: 0,
    });
  });

  it('groups files by folder, formats stats, and collapses or expands folder sections', () => {
    const selectedFiles = new Set<string>([
      'folder-a::src/file-b.ts',
      'folder-a::src/file-a.ts',
      'folder-b::README.md',
    ]);

    mockUsePersistentTokenCache.mockReturnValue(
      createPersistentTokenCacheMock({
        getFileSize: (compositeKey: string) =>
          compositeKey === 'folder-b::README.md' ? 4096 : undefined,
        getTokenCount: (compositeKey: string) =>
          compositeKey === 'folder-a::src/file-a.ts'
            ? 1100
            : compositeKey === 'folder-a::src/file-b.ts'
              ? 900
              : undefined,
      })
    );

    const { result } = renderHook(() =>
      usePreviewPanelState({
        selectedFiles,
        fileContents: {},
        loadingFiles: new Set<string>(),
        onSelectionChange: vi.fn(),
        fileSizes: {
          'folder-a::src/file-a.ts': 512,
          'folder-a::src/file-b.ts': 1536,
        },
        decodeFileSelection,
        tokenCounting,
        performUndoableAction: vi.fn(),
      })
    );

    expect(result.current.flatListItems).toMatchObject([
      { type: 'folder-header', folderId: 'folder-a', fileCount: 2, totalTokens: 2000 },
      { type: 'file', path: 'src/file-a.ts', size: 512, tokens: 1100 },
      { type: 'file', path: 'src/file-b.ts', size: 1536, tokens: 900 },
      { type: 'folder-header', folderId: 'folder-b', fileCount: 1, totalTokens: 0 },
      { type: 'file', path: 'README.md', size: 4096 },
    ]);
    expect(result.current.formatFileSize()).toBe('Unknown');
    expect(result.current.formatFileSize(1536)).toBe('1.5 KB');
    expect(result.current.formatFileSize(1_048_576)).toBe('1.0 MB');
    expect(result.current.formatFileSize(1_099_511_627_776)).toBe('1.0 TB');

    act(() => {
      result.current.toggleFolderCollapse('folder-a');
    });

    expect(result.current.flatListItems.map((item) => item.type)).toEqual([
      'folder-header',
      'folder-header',
      'file',
    ]);

    act(() => {
      result.current.expandAllFolders();
    });

    expect(result.current.flatListItems.filter((item) => item.type === 'file')).toHaveLength(3);

    act(() => {
      result.current.collapseAllFolders();
    });

    expect(result.current.flatListItems.every((item) => item.type === 'folder-header')).toBe(true);
  });

  it('tracks batch selection and removes selected files with undo metadata', () => {
    const selectedFiles = new Set<string>([
      'folder-a::src/file-a.ts',
      'folder-a::src/file-b.ts',
      'folder-b::README.md',
    ]);
    const onSelectionChange = vi.fn();
    const performUndoableAction = vi.fn();

    const { result } = renderHook(() =>
      usePreviewPanelState({
        selectedFiles,
        fileContents: {},
        loadingFiles: new Set<string>(),
        onSelectionChange,
        fileSizes: {},
        decodeFileSelection,
        tokenCounting,
        performUndoableAction,
      })
    );

    expect(result.current.isAllFilesSelected).toBe(false);

    act(() => {
      result.current.toggleFileSelection('folder-a::src/file-a.ts', true);
      result.current.toggleFileSelection('folder-b::README.md', true);
    });

    expect(result.current.batchSelectedFiles).toEqual(
      new Set(['folder-a::src/file-a.ts', 'folder-b::README.md'])
    );

    act(() => {
      result.current.toggleFileSelection('folder-b::README.md', false);
    });

    expect(result.current.batchSelectedFiles).toEqual(new Set(['folder-a::src/file-a.ts']));

    act(() => {
      result.current.handleSelectAll();
    });

    expect(result.current.isAllFilesSelected).toBe(true);

    act(() => {
      result.current.handleBatchRemove();
    });

    expect(onSelectionChange).toHaveBeenCalledWith(new Set<string>());
    expect(performUndoableAction).toHaveBeenCalledWith(
      'batch-remove',
      'batch-remove',
      expect.objectContaining({
        actionName: 'Files removed',
        itemDescription: 'Removed 3 files from selection',
      })
    );
    expect(result.current.batchSelectedFiles.size).toBe(0);

    const undo = performUndoableAction.mock.calls[0]?.[2]?.onUndo;
    act(() => {
      undo?.('batch-remove', selectedFiles);
    });

    expect(onSelectionChange).toHaveBeenLastCalledWith(selectedFiles);

    act(() => {
      result.current.handleDeselectAll();
    });

    expect(result.current.batchSelectedFiles.size).toBe(0);
  });

  it('removes one file and restores it through the undo callback', () => {
    const selectedFiles = new Set<string>(['folder-a::src/file-a.ts', 'folder-a::src/file-b.ts']);
    const onSelectionChange = vi.fn();
    const performUndoableAction = vi.fn();

    const { result } = renderHook(() =>
      usePreviewPanelState({
        selectedFiles,
        fileContents: {},
        loadingFiles: new Set<string>(),
        onSelectionChange,
        fileSizes: {},
        decodeFileSelection,
        tokenCounting,
        performUndoableAction,
      })
    );

    act(() => {
      result.current.handleRemoveFile('folder-a::src/file-a.ts');
    });

    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['folder-a::src/file-b.ts']));
    expect(performUndoableAction).toHaveBeenCalledWith(
      'folder-a::src/file-a.ts',
      'folder-a::src/file-a.ts',
      expect.objectContaining({
        actionName: 'File removed',
        itemDescription: 'Removed "src/file-a.ts" from selection',
      })
    );

    const undo = performUndoableAction.mock.calls[0]?.[2]?.onUndo;
    act(() => {
      undo?.('folder-a::src/file-a.ts', new Set(['folder-a::src/file-b.ts']));
    });

    expect(onSelectionChange).toHaveBeenLastCalledWith(
      new Set(['folder-a::src/file-a.ts', 'folder-a::src/file-b.ts'])
    );
  });
});
