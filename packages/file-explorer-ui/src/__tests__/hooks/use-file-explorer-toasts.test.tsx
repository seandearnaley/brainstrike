import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useFileExplorerToasts } from '../../hooks/use-file-explorer-toasts';

// Mock the file-explorer-hooks module with spyable fns
const mockShowToast = vi.fn();
const mockHandleRefreshError = vi.fn();
const mockHandleBrowserCompatibilityError = vi.fn();
const mockHandleDirectorySelectError = vi.fn();

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: {},
    storageAdapter: {
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    },
  }),
  useToastManager: () => ({
    handleBrowserCompatibilityError: mockHandleBrowserCompatibilityError,
    handleDirectorySelectError: mockHandleDirectorySelectError,
    handleRefreshError: mockHandleRefreshError,
    showToast: mockShowToast,
    toast: null,
  }),
}));

// Create a wrapper to provide necessary context
const createWrapper = () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return Wrapper;
};

describe('useFileExplorerToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockParams = (overrides = {}) => ({
    cancelOperation: vi.fn(),
    handleRootDirectorySelect: vi.fn().mockResolvedValue(null),
    isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
    refreshFileExplorer: vi.fn().mockResolvedValue({ status: 'completed' }),
    rootDirectoryHandle: null,
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
  });

  it('should return isRefreshing as false initially', () => {
    const params = createMockParams();
    const { result } = renderHook(() => useFileExplorerToasts(params), {
      wrapper: createWrapper(),
    });

    expect(result.current.isRefreshing).toBe(false);
  });

  it('should return handleRefresh, handleDirectorySelect, and handleCancelOperation', () => {
    const params = createMockParams();
    const { result } = renderHook(() => useFileExplorerToasts(params), {
      wrapper: createWrapper(),
    });

    expect(typeof result.current.handleRefresh).toBe('function');
    expect(typeof result.current.handleDirectorySelect).toBe('function');
    expect(typeof result.current.handleCancelOperation).toBe('function');
  });

  describe('handleRefresh', () => {
    it('should not refresh when rootDirectoryHandle is null', async () => {
      const refreshFileExplorer = vi.fn();
      const params = createMockParams({ refreshFileExplorer, rootDirectoryHandle: null });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(refreshFileExplorer).not.toHaveBeenCalled();
    });

    it('should call refreshFileExplorer when rootDirectoryHandle exists', async () => {
      const refreshFileExplorer = vi.fn().mockResolvedValue({ status: 'completed' });
      const mockHandle = { name: 'test-folder' };
      const params = createMockParams({
        refreshFileExplorer,
        rootDirectoryHandle: mockHandle,
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(refreshFileExplorer).toHaveBeenCalledTimes(1);
    });

    it('should set isRefreshing during refresh operation', async () => {
      let resolveRefresh: (result: { status: 'completed' }) => void;
      const refreshPromise = new Promise<{ status: 'completed' }>((resolve) => {
        resolveRefresh = resolve;
      });
      const refreshFileExplorer = vi.fn().mockReturnValue(refreshPromise);
      const mockHandle = { name: 'test-folder' };
      const params = createMockParams({
        refreshFileExplorer,
        rootDirectoryHandle: mockHandle,
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      const refreshPromiseResult = result.current.handleRefresh();

      await waitFor(() => {
        expect(result.current.isRefreshing).toBe(true);
      });

      resolveRefresh!({ status: 'completed' });
      await refreshPromiseResult;

      await waitFor(() => {
        expect(result.current.isRefreshing).toBe(false);
      });
    });

    it('should show success toast after successful refresh', async () => {
      const refreshFileExplorer = vi.fn().mockResolvedValue({ status: 'completed' });
      const mockHandle = { name: 'test-folder' };
      const params = createMockParams({
        refreshFileExplorer,
        rootDirectoryHandle: mockHandle,
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.any(String),
          title: expect.any(String),
        })
      );
    });

    it('should not show success or error feedback when refresh is cancelled', async () => {
      const refreshFileExplorer = vi.fn().mockResolvedValue({ status: 'cancelled' });
      const params = createMockParams({
        refreshFileExplorer,
        rootDirectoryHandle: { name: 'test-folder' },
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(mockShowToast).not.toHaveBeenCalled();
      expect(mockHandleRefreshError).not.toHaveBeenCalled();
      expect(result.current.isRefreshing).toBe(false);
    });

    it('should call handleRefreshError when refresh fails', async () => {
      const refreshError = new Error('Refresh failed');
      const refreshFileExplorer = vi.fn().mockRejectedValue(refreshError);
      const mockHandle = { name: 'test-folder' };
      const params = createMockParams({
        refreshFileExplorer,
        rootDirectoryHandle: mockHandle,
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(mockHandleRefreshError).toHaveBeenCalledWith(refreshError);
      expect(result.current.isRefreshing).toBe(false);
    });

    it('should reset isRefreshing even when refresh fails', async () => {
      const refreshFileExplorer = vi.fn().mockRejectedValue(new Error('fail'));
      const mockHandle = { name: 'folder' };
      const params = createMockParams({
        refreshFileExplorer,
        rootDirectoryHandle: mockHandle,
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(result.current.isRefreshing).toBe(false);
    });

    it('should not show toast when rootDirectoryHandle is null', async () => {
      const params = createMockParams({ rootDirectoryHandle: null });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleRefresh();

      expect(mockShowToast).not.toHaveBeenCalled();
    });
  });

  describe('handleDirectorySelect', () => {
    it('should not call handleRootDirectorySelect when browser not supported', async () => {
      const params = createMockParams({
        isFileSystemAccessSupported: vi
          .fn()
          .mockReturnValue({ reason: 'Browser not supported', supported: false }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleDirectorySelect();

      expect(params.handleRootDirectorySelect).not.toHaveBeenCalled();
    });

    it('should call handleBrowserCompatibilityError when not supported', async () => {
      const reason = 'Your browser does not support the File System Access API';
      const params = createMockParams({
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason, supported: false }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleDirectorySelect();

      expect(mockHandleBrowserCompatibilityError).toHaveBeenCalledWith(reason);
    });

    it('should call handleRootDirectorySelect when supported', async () => {
      const handleRootDirectorySelect = vi.fn().mockResolvedValue({ name: 'selected-folder' });
      const params = createMockParams({
        handleRootDirectorySelect,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
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
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await expect(result.current.handleDirectorySelect()).resolves.toBeUndefined();
    });

    it('should call handleDirectorySelectError when directory select fails', async () => {
      const selectError = new Error('Directory select failed');
      const handleRootDirectorySelect = vi.fn().mockRejectedValue(selectError);
      const params = createMockParams({
        handleRootDirectorySelect,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleDirectorySelect();

      expect(mockHandleDirectorySelectError).toHaveBeenCalledWith(selectError);
    });

    it('should not call any error handler on successful directory selection', async () => {
      const handleRootDirectorySelect = vi.fn().mockResolvedValue({ name: 'my-folder' });
      const params = createMockParams({
        handleRootDirectorySelect,
        isFileSystemAccessSupported: vi.fn().mockReturnValue({ reason: '', supported: true }),
      });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      await result.current.handleDirectorySelect();

      expect(mockHandleBrowserCompatibilityError).not.toHaveBeenCalled();
      expect(mockHandleDirectorySelectError).not.toHaveBeenCalled();
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

    it('should show cancel toast with correct title and description', () => {
      const cancelOperation = vi.fn();
      const params = createMockParams({ cancelOperation });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      result.current.handleCancelOperation();

      expect(mockShowToast).toHaveBeenCalledWith({
        description: 'The file loading operation has been cancelled.',
        title: 'Operation Cancelled',
        variant: 'default',
      });
    });

    it('should call showToast exactly once per cancel', () => {
      const cancelOperation = vi.fn();
      const params = createMockParams({ cancelOperation });

      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      result.current.handleCancelOperation();
      result.current.handleCancelOperation();

      expect(mockShowToast).toHaveBeenCalledTimes(2);
      expect(cancelOperation).toHaveBeenCalledTimes(2);
    });
  });

  describe('passthrough functions', () => {
    it('should expose handleRefreshError from toast manager', () => {
      const params = createMockParams();
      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      expect(result.current.handleRefreshError).toBe(mockHandleRefreshError);
    });

    it('should expose handleBrowserCompatibilityError from toast manager', () => {
      const params = createMockParams();
      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      expect(result.current.handleBrowserCompatibilityError).toBe(
        mockHandleBrowserCompatibilityError
      );
    });

    it('should expose handleDirectorySelectError from toast manager', () => {
      const params = createMockParams();
      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      expect(result.current.handleDirectorySelectError).toBe(mockHandleDirectorySelectError);
    });

    it('should expose showToast from toast manager', () => {
      const params = createMockParams();
      const { result } = renderHook(() => useFileExplorerToasts(params), {
        wrapper: createWrapper(),
      });

      expect(result.current.showToast).toBe(mockShowToast);
    });
  });
});
