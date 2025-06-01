import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  UnifiedFileExplorerProvider,
  useUnifiedFileExplorer,
} from '../unified-file-explorer-context';

vi.mock('../use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(),
}));

const mockValues = {
  fileTree: [],
  fileContents: {},
  loadingFiles: new Set<string>(),
  loadFileContent: vi.fn(),
  handleRootDirectorySelect: vi.fn(),
  isLoading: false,
  error: null,
  rootDirectoryHandle: null,
  isFileSystemAccessSupported: vi.fn(),
  refreshFileExplorer: vi.fn(),
  applyFileFilters: vi.fn(),
  filterError: null,
  isInitialLoad: false,
  clearFileContents: vi.fn(),
  loadingProgress: null,
  cancellable: false,
  cancelOperation: vi.fn(),
  isCancelling: false,
};

import { useFileExplorer } from '../use-file-explorer-context';
vi.mocked(useFileExplorer).mockReturnValue(mockValues);

function wrapper({ children }: { children: ReactNode }) {
  return <UnifiedFileExplorerProvider>{children}</UnifiedFileExplorerProvider>;
}

describe('UnifiedFileExplorerContext', () => {
  it('provides values from useFileExplorer', () => {
    const { result } = renderHook(() => useUnifiedFileExplorer(), {
      wrapper,
    });
    expect(result.current).toStrictEqual(mockValues);
  });

  it('throws when used outside provider', () => {
    expect(() => {
      renderHook(() => useUnifiedFileExplorer());
    }).toThrow('useUnifiedFileExplorer must be used within a UnifiedFileExplorerProvider');
  });
});
