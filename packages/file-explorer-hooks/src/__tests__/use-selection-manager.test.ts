import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionManager } from '../use-selection-manager';

type UseSelectionManagerArgs = Parameters<typeof useSelectionManager>[0];

describe('useSelectionManager', () => {
  const mockSetSelectedFiles = vi.fn();
  const mockOnSelectionLimitExceeded = vi.fn();
  let initialSelectedPaths: Set<string>;
  const maxCount = 5;

  beforeEach(() => {
    mockSetSelectedFiles.mockReset();
    mockOnSelectionLimitExceeded.mockReset();
    initialSelectedPaths = new Set(['file1', 'file2']);
  });

  const renderSelectionManager = (params: UseSelectionManagerArgs) =>
    renderHook((props: UseSelectionManagerArgs) => useSelectionManager(props), {
      initialProps: params,
    });

  it('returns the current selected file paths', () => {
    const { result } = renderSelectionManager({
      selectedFilePaths: initialSelectedPaths,
      maxSelectionCount: maxCount,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    });
    expect(result.current.selectedFilePaths).toEqual(initialSelectedPaths);
  });

  it('checks if selection would exceed limit and returns true when it would', () => {
    const { result } = renderSelectionManager({
      selectedFilePaths: initialSelectedPaths,
      maxSelectionCount: maxCount,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    });
    const wouldExceed = result.current.wouldExceedSelectionLimit([
      'file3',
      'file4',
      'file5',
      'file6',
    ]);
    expect(wouldExceed).toBe(true);
  });

  it('checks if selection would exceed limit and returns false when it would not', () => {
    const { result } = renderSelectionManager({
      selectedFilePaths: initialSelectedPaths,
      maxSelectionCount: maxCount,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    });
    const wouldExceed = result.current.wouldExceedSelectionLimit(['file3', 'file4', 'file5']);
    expect(wouldExceed).toBe(false);
  });

  it('excludes already selected files when checking limit', () => {
    const { result } = renderSelectionManager({
      selectedFilePaths: initialSelectedPaths,
      maxSelectionCount: maxCount,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    });
    const wouldExceed = result.current.wouldExceedSelectionLimit([
      'file1',
      'file2',
      'file3',
      'file4',
      'file5',
    ]);
    expect(wouldExceed).toBe(false);
  });

  it('clips selection to the max instead of showing a limit error', () => {
    const { result } = renderSelectionManager({
      selectedFilePaths: initialSelectedPaths,
      maxSelectionCount: maxCount,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    });
    act(() => {
      result.current.handleSelectionChange(new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']));
    });
    expect(mockOnSelectionLimitExceeded).not.toHaveBeenCalled();
    expect(mockSetSelectedFiles).toHaveBeenCalledWith(new Set(['f1', 'f2', 'f3', 'f4', 'f5']));
  });

  it('updates selection when new selection is within limit', () => {
    const { result } = renderSelectionManager({
      selectedFilePaths: initialSelectedPaths,
      maxSelectionCount: maxCount,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    });
    const newSelection = new Set(['file1', 'file2', 'file3']);
    act(() => {
      result.current.handleSelectionChange(newSelection);
    });
    expect(mockOnSelectionLimitExceeded).not.toHaveBeenCalled();
    expect(mockSetSelectedFiles).toHaveBeenCalledWith(newSelection);
  });

  it('re-evaluates selection limits after dependencies change', () => {
    const initialProps: UseSelectionManagerArgs = {
      selectedFilePaths: new Set(['file1']),
      maxSelectionCount: 1,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    };

    const { result, rerender } = renderSelectionManager(initialProps);
    expect(result.current.wouldExceedSelectionLimit(['file2'])).toBe(true);

    const nextSetSelectedFiles = vi.fn();
    const nextOnSelectionLimitExceeded = vi.fn();

    rerender({
      selectedFilePaths: new Set(['file1', 'file2']),
      maxSelectionCount: 3,
      setSelectedFiles: nextSetSelectedFiles,
      onSelectionLimitExceeded: nextOnSelectionLimitExceeded,
    });

    expect(result.current.wouldExceedSelectionLimit(['file3'])).toBe(false);
  });

  it('uses latest handlers when dependencies change', () => {
    const initialProps: UseSelectionManagerArgs = {
      selectedFilePaths: new Set(['file1']),
      maxSelectionCount: 1,
      setSelectedFiles: mockSetSelectedFiles,
      onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
    };

    const { result, rerender } = renderSelectionManager(initialProps);

    const nextSetSelectedFiles = vi.fn();
    const nextOnSelectionLimitExceeded = vi.fn();

    rerender({
      selectedFilePaths: new Set(),
      maxSelectionCount: 3,
      setSelectedFiles: nextSetSelectedFiles,
      onSelectionLimitExceeded: nextOnSelectionLimitExceeded,
    });

    const nextSelection = new Set(['file2', 'file3']);
    act(() => {
      result.current.handleSelectionChange(nextSelection);
    });

    expect(nextOnSelectionLimitExceeded).not.toHaveBeenCalled();
    expect(nextSetSelectedFiles).toHaveBeenCalledWith(nextSelection);
    expect(mockSetSelectedFiles).not.toHaveBeenCalled();
    expect(mockOnSelectionLimitExceeded).not.toHaveBeenCalled();
  });
});
