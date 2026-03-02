import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePreviewPanelState } from '../use-preview-panel-state';
import type { TokenCountingState } from '../use-token-counting';

vi.mock('../use-persistent-token-cache', () => ({
  usePersistentTokenCache: () => ({
    cacheVersion: 0,
    getFileSize: () => undefined,
    getTokenCount: () => undefined,
    isAnyLoading: false,
    pendingRequestsRef: { current: new Map() },
    tokenCacheRef: { current: new Map() },
  }),
}));

const tokenCounting: TokenCountingState = {
  countTokens: async () => 0,
  loading: false,
  mode: 'heuristic',
  reason: null,
};

describe('usePreviewPanelState path sorting', () => {
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

    expect(fileItems.map((item) => item.path)).toEqual([
      'src/file1.ts',
      'src/file10.ts',
      'src/file2.ts',
    ]);
  });
});
