import { mockDirectoryHandle } from '@/lib/file/__tests__/utils/mock-file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import { useFileSystem } from '../use-file-system';

// Mock the useFileExplorerStore
const mockSetCurrentFolderId = jest.fn();
jest.mock('../../stores/use-file-explorer-store', () => ({
  useFileExplorerStore: jest.fn(() => ({
    setCurrentFolderId: mockSetCurrentFolderId,
    currentFolderId: 'test-folder-id',
  })),
}));

// Mock the file system module
jest.mock('../../lib/file/system', () => ({
  fileSystem: {
    generateUniqueFolderId: jest.fn().mockResolvedValue('test-folder-id'),
    isSameDirectory: jest.fn().mockResolvedValue(true),
  },
}));

describe('useFileSystem', () => {
  let mockShowDirectoryPicker: jest.Mock;

  const createMockDirectoryHandle = () => ({
    kind: 'directory' as const,
    requestPermission: jest.fn().mockResolvedValue('granted'),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockShowDirectoryPicker = jest.fn();
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: mockShowDirectoryPicker,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
      writable: true,
    });
  });

  describe('isFileSystemAccessSupported', () => {
    it('returns supported true when API is available and context is secure', () => {
      const { result } = renderHook(() => useFileSystem());
      const { supported, reason } = result.current.isFileSystemAccessSupported();
      expect(supported).toBe(true);
      expect(reason).toBe('');
    });

    it('returns supported false when API is not available', () => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: null,
        configurable: true,
      });
      const { result } = renderHook(() => useFileSystem());
      const { supported, reason } = result.current.isFileSystemAccessSupported();
      expect(supported).toBe(false);
      expect(reason).toBe('File System Access API is not supported in this browser');
    });

    it('returns supported false when context is not secure', () => {
      Object.defineProperty(window, 'isSecureContext', {
        value: false,
        configurable: true,
      });
      const { result } = renderHook(() => useFileSystem());
      const { supported, reason } = result.current.isFileSystemAccessSupported();
      expect(supported).toBe(false);
      expect(reason).toBe('File System Access API requires a secure context (HTTPS)');
    });
  });

  describe('selectRootDirectory', () => {
    it('sets root directory handle and updates folder state when selection is successful', async () => {
      const mockDirectoryHandle = createMockDirectoryHandle();
      mockShowDirectoryPicker.mockResolvedValue(mockDirectoryHandle);

      const { result } = renderHook(() => useFileSystem());

      await act(async () => {
        const handle = await result.current.selectRootDirectory();
        expect(handle).toBe(mockDirectoryHandle);
      });

      expect(result.current.rootDirectoryHandle).toBe(mockDirectoryHandle);
    });

    it('throws error when File System Access API is not supported', async () => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: null,
        configurable: true,
      });
      const { result } = renderHook(() => useFileSystem());

      await act(async () => {
        await expect(result.current.selectRootDirectory()).rejects.toThrow(
          'File System Access API is not supported in this browser'
        );
      });
    });

    it('throws error when permission is denied', async () => {
      const error = new Error('Permission denied');
      error.name = 'SecurityError';
      mockShowDirectoryPicker.mockRejectedValue(error);

      const { result } = renderHook(() => useFileSystem());

      await act(async () => {
        await expect(result.current.selectRootDirectory()).rejects.toThrow('Permission denied');
      });
    });

    it('returns null when selection is cancelled', async () => {
      const error = new Error('User cancelled');
      error.name = 'AbortError';
      mockShowDirectoryPicker.mockRejectedValue(error);

      const { result } = renderHook(() => useFileSystem());

      let handle: FileSystemDirectoryHandle | null = null;
      await act(async () => {
        handle = await result.current.selectRootDirectory();
      });
      expect(handle).toBeNull();
    });

    it('throws original error for unknown errors', async () => {
      const error = new Error('Unknown error');
      mockShowDirectoryPicker.mockRejectedValue(error);

      const { result } = renderHook(() => useFileSystem());

      await act(async () => {
        await expect(result.current.selectRootDirectory()).rejects.toThrow('Unknown error');
      });
    });
  });
});
