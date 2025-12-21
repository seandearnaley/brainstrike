import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useSelectionManager } from '../use-selection-manager-context';

vi.mock('../file-explorer-provider', () => ({
  useFileExplorerStoreContext: vi.fn(),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useSelectionManager: vi.fn(({ selectedFilePaths, setSelectedFiles }) => ({
    handleSelectionChange: vi.fn((next) => setSelectedFiles?.(next)),
    selectedFilePaths,
  })),
}));

describe('useSelectionManager', () => {
  it('initializes with store state', () => {
    const setSelectedFiles = vi.fn();
    const selectedFilePaths = new Set(['file1.ts']);
    const mockStore = Object.assign(
      (selector: any) => selector({ selectedFilePaths, maxSelectionCount: 10, setSelectedFiles }),
      { getState: () => ({ selectedFilePaths, maxSelectionCount: 10, setSelectedFiles }) }
    );
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(mockStore as any);

    const onSelectionLimitExceeded = vi.fn();
    const { result } = renderHook(() => useSelectionManager({ onSelectionLimitExceeded }));

    expect(result.current.selectedFilesList).toEqual(['file1.ts']);

    // Test setSelectedFilesStable via setSelectedFilesFromList
    result.current.setSelectedFilesFromList(['file1.ts', 'file2.ts']);
    expect(setSelectedFiles).toHaveBeenCalled();
    const call = setSelectedFiles.mock.calls[0]![0];
    expect(call).toBeInstanceOf(Set);
    expect(Array.from(call as Set<string>)).toEqual(['file1.ts', 'file2.ts']);
  });
});
