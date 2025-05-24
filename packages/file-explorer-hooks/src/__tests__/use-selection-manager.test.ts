import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionManager } from '../use-selection-manager';

describe('useSelectionManager', () => {
  const mockSetSelectedFiles = vi.fn();
  const mockOnSelectionLimitExceeded = vi.fn();
  let initialSelectedPaths: Set<string>;
  const maxCount = 5;

  beforeEach(() => {
    vi.clearAllMocks();
    initialSelectedPaths = new Set(['file1', 'file2']);
    // Remove mockReturnValue for useFileExplorerStore as it's not directly used by this hook
  });

  it('returns the current selected file paths', () => {
    const { result } = renderHook(() =>
      useSelectionManager({
        selectedFilePaths: initialSelectedPaths,
        maxSelectionCount: maxCount,
        setSelectedFiles: mockSetSelectedFiles,
        onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
      })
    );
    expect(result.current.selectedFilePaths).toEqual(initialSelectedPaths);
  });

  it('checks if selection would exceed limit and returns true when it would', () => {
    const { result } = renderHook(() =>
      useSelectionManager({
        selectedFilePaths: initialSelectedPaths,
        maxSelectionCount: maxCount,
        setSelectedFiles: mockSetSelectedFiles,
        onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
      })
    );
    const wouldExceed = result.current.wouldExceedSelectionLimit([
      'file3',
      'file4',
      'file5',
      'file6',
    ]);
    expect(wouldExceed).toBe(true);
  });

  it('checks if selection would exceed limit and returns false when it would not', () => {
    const { result } = renderHook(() =>
      useSelectionManager({
        selectedFilePaths: initialSelectedPaths,
        maxSelectionCount: maxCount,
        setSelectedFiles: mockSetSelectedFiles,
        onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
      })
    );
    const wouldExceed = result.current.wouldExceedSelectionLimit(['file3', 'file4', 'file5']);
    expect(wouldExceed).toBe(false);
  });

  it('excludes already selected files when checking limit', () => {
    const { result } = renderHook(() =>
      useSelectionManager({
        selectedFilePaths: initialSelectedPaths,
        maxSelectionCount: maxCount,
        setSelectedFiles: mockSetSelectedFiles,
        onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
      })
    );
    const wouldExceed = result.current.wouldExceedSelectionLimit([
      'file1',
      'file2',
      'file3',
      'file4',
      'file5',
    ]);
    expect(wouldExceed).toBe(false);
  });

  it('calls onSelectionLimitExceeded when new selection would exceed limit', () => {
    const { result } = renderHook(() =>
      useSelectionManager({
        selectedFilePaths: initialSelectedPaths,
        maxSelectionCount: maxCount,
        setSelectedFiles: mockSetSelectedFiles,
        onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
      })
    );
    act(() => {
      result.current.handleSelectionChange(new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']));
    });
    expect(mockOnSelectionLimitExceeded).toHaveBeenCalled();
    expect(mockSetSelectedFiles).not.toHaveBeenCalled();
  });

  it('updates selection when new selection is within limit', () => {
    const { result } = renderHook(() =>
      useSelectionManager({
        selectedFilePaths: initialSelectedPaths,
        maxSelectionCount: maxCount,
        setSelectedFiles: mockSetSelectedFiles,
        onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
      })
    );
    const newSelection = new Set(['file1', 'file2', 'file3']);
    act(() => {
      result.current.handleSelectionChange(newSelection);
    });
    expect(mockOnSelectionLimitExceeded).not.toHaveBeenCalled();
    expect(mockSetSelectedFiles).toHaveBeenCalledWith(newSelection);
  });
});
