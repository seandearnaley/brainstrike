import { renderHook, waitFor } from '@testing-library/react';
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

  // BST-1211 pins the ORDER, because it is observable: preview-panel.tsx sorts
  // this list with a STABLE comparator (by rootFolderId only), so ties keep
  // whatever order arrives here, and that decides Tapestry card order.
  //
  // The rule is "files bucketed by their owning root in first-seen order, then
  // path-sorted WITHIN each bucket" — not a single global path sort. The fixture
  // below is chosen to tell those two apart: a flat sort would put `README.md`
  // first (R < s), and the folder buckets must keep it last.
  it('buckets files by first-seen folder and path-sorts only within a bucket', () => {
    const selectedFiles = new Set<string>([
      'folder-a::src/file-b.ts',
      'folder-a::src/file-a.ts',
      'folder-b::README.md',
    ]);

    const { result } = renderHook(() =>
      usePreviewPanelState({
        decodeFileSelection,
        fileContents: {},
        loadingFiles: new Set<string>(),
        selectedFiles,
        tokenCounting,
      })
    );

    expect(
      result.current.flatListItems
        .filter((item) => item.type === 'file')
        .map((item) => item.compositeKey)
    ).toEqual(['folder-a::src/file-a.ts', 'folder-a::src/file-b.ts', 'folder-b::README.md']);
  });

  it('preserves default localeCompare ordering for numeric substrings', () => {
    const selectedFiles = new Set<string>([
      'folder::src/file2.ts',
      'folder::src/file10.ts',
      'folder::src/file1.ts',
    ]);

    const { result } = renderHook(() =>
      usePreviewPanelState({
        decodeFileSelection,
        fileContents: {},
        fileSizes: {},
        loadingFiles: new Set<string>(),
        selectedFiles,
        tokenCounting,
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
        decodeFileSelection,
        fileContents: {},
        fileSizes: {},
        loadingFiles: new Set<string>(),
        selectedFiles,
        tokenCounting,
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
        decodeFileSelection,
        fileContents: {},
        fileSizes: {},
        loadingFiles: new Set<string>(),
        selectedFiles,
        tokenCounting,
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
          decodeFileSelection,
          fileContents: {},
          fileSizes: {},
          loadingFiles: new Set<string>(),
          selectedFiles,
          tokenCounting,
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

  it('carries per-file size and token metadata onto each bucketed file', () => {
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
        decodeFileSelection,
        fileContents: {},
        fileSizes: {
          'folder-a::src/file-a.ts': 512,
          'folder-a::src/file-b.ts': 1536,
        },
        loadingFiles: new Set<string>(),
        selectedFiles,
        tokenCounting,
      })
    );

    // `fileSizes` wins where present; the persistent cache fills the rest.
    expect(result.current.flatListItems).toMatchObject([
      { path: 'src/file-a.ts', size: 512, tokens: 1100, type: 'file' },
      { path: 'src/file-b.ts', size: 1536, tokens: 900, type: 'file' },
      { path: 'README.md', size: 4096, type: 'file' },
    ]);
    // A file whose token count has not resolved carries no `tokens` key at all,
    // which is what keeps it in totalStats.pendingCount.
    expect(result.current.flatListItems[2]).not.toHaveProperty('tokens');
  });
});
