import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useFileExplorerToasts } from '../../hooks/use-file-explorer-toasts';

// Mock the file-explorer-hooks module
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useToastManager: () => ({
    toast: null,
    showToast: vi.fn(),
    handleRefreshError: vi.fn(),
    handlePartialRefreshError: vi.fn(),
    handleBrowserCompatibilityError: vi.fn(),
    handleDirectorySelectError: vi.fn(),
    handleSelectionLimitError: vi.fn(),
  }),
  useAdapters: () => ({
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    fileSystemAdapter: {},
  }),
}));

// Create a wrapper to provide necessary context
const createWrapper = () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return Wrapper;
};

describe('useFileExplorerToasts', () => {
  const createMockParams = (overrides = {}) => ({
    rootDirectoryHandle: null,
    refreshFileExplorer: vi.fn().mockResolvedValue(undefined),
    handleRootDirectorySelect: vi.fn().mockResolvedValue(null),
    isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
    cancelOperation: vi.fn(),
    ...overrides,
  });

  it('should return toast manager functions', () => {
    const params = createMockParams();
    const { result } = renderHook(() => useFileExplorerToasts(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.toast).toBeNull();
    expect(result.current.showToast).toBeDefined();
    expect(result.current.handleRefreshError).toBeDefined();
    expect(result.current.handleBrowserCompatibilityError).toBeDefined();
    expect(result.current.handleDirectorySelectError).toBeDefined();
    expect(result.current.handleSelectionLimitError).toBeDefined();
  });

  it('should return isRefreshing as false initially', () => {
    const params = createMockParams();
    const { result } = renderHook(() => useFileExplorerToasts(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.isRefreshing).toBe(false);
  });

  describe('handleRefresh', () => {
    it('should not refresh when rootDirectoryHandle is null', async () => {
      const refreshFileExplorer = vi.fn();
      const params = createMockParams({ rootDirectoryHandle: null, refreshFileExplorer });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(refreshFileExplorer).not.toHaveBeenCalled();
    });

    it('should call refreshFileExplorer when rootDirectoryHandle exists', async () => {
      const refreshFileExplorer = vi.fn().mockResolvedValue(undefined);
      const mockHandle = { name: 'test-folder' };
      const params = createMockParams({
        rootDirectoryHandle: mockHandle,
        refreshFileExplorer,
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(refreshFileExplorer).toHaveBeenCalledTimes(1);
    });

    it('should set isRefreshing during refresh operation', async () => {
      let resolveRefresh: () => void;
      const refreshPromise = new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
      const refreshFileExplorer = vi.fn().mockReturnValue(refreshPromise);
      const mockHandle = { name: 'test-folder' };
      const params = createMockParams({
        rootDirectoryHandle: mockHandle,
        refreshFileExplorer,
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      const refreshPromiseResult = result.current.handleRefresh();

      await waitFor(() => {
        expect(result.current.isRefreshing).toBe(true);
      });

      resolveRefresh!();
      await refreshPromiseResult;

      await waitFor(() => {
        expect(result.current.isRefreshing).toBe(false);
      });
    });
  });

  describe('handleDirectorySelect', () => {
    it('should not call handleRootDirectorySelect when browser not supported', async () => {
      const params = createMockParams({
        isFileSystemAccessSupported: vi
          .fn()
          .mockReturnValue({ supported: false, reason: 'Browser not supported' }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleDirectorySelect();

      // The function should return early and not call handleRootDirectorySelect
      expect(params.handleRootDirectorySelect).not.toHaveBeenCalled();
    });

    it('should call handleRootDirectorySelect when supported', async () => {
      const handleRootDirectorySelect = vi.fn().mockResolvedValue({ name: 'selected-folder' });
      const params = createMockParams({
        handleRootDirectorySelect,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleDirectorySelect();

      expect(handleRootDirectorySelect).toHaveBeenCalledTimes(1);
    });

    it('should handle null return from directory select (user cancelled)', async () => {
      const handleRootDirectorySelect = vi.fn().mockResolvedValue(null);
      const params = createMockParams({
        handleRootDirectorySelect,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      // Should not throw
      await expect(result.current.handleDirectorySelect()).resolves.toBeUndefined();
    });
  });

  describe('handleCancelOperation', () => {
    it('should call cancelOperation', () => {
      const cancelOperation = vi.fn();
      const params = createMockParams({ cancelOperation });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      result.current.handleCancelOperation();

      expect(cancelOperation).toHaveBeenCalledTimes(1);
    });
  });
});
