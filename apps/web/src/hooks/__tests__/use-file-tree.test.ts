import { PartialRefreshError } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../use-file-tree';

describe('useFileTree', () => {
  let mockDirectoryHandle: FileSystemDirectoryHandle;
  let mockFileHandle: FileSystemFileHandle;

  beforeEach(() => {
    mockFileHandle = {
      kind: 'file' as const,
      name: 'test.txt',
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandle;

    mockDirectoryHandle = {
      kind: 'directory' as const,
      name: 'root',
      entries: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;
  });

  it('should initialize with empty state', () => {
    const { result } = renderHook(() => useFileTree(null));

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  describe('Partial Refresh Scenarios', () => {
    it('should throw PartialRefreshError when some files fail to load', async () => {
      // Mock a directory with mixed success/failure
      const mockEntries = [
        ['success.txt', mockFileHandle],
        [
          'fail.txt',
          {
            ...mockFileHandle,
            getFile: vi.fn().mockRejectedValue(new Error('Access denied')),
          },
        ],
      ];
      mockDirectoryHandle.entries = vi.fn().mockImplementation(async function* () {
        yield* mockEntries;
      });

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle));

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      if (error instanceof PartialRefreshError) {
        expect(error.successCount).toBe(1);
        expect(error.failCount).toBe(1);
      }
    });

    it('should throw regular Error when all files fail to load', async () => {
      // Mock a directory where all files fail
      const mockEntries = [
        [
          'fail1.txt',
          {
            ...mockFileHandle,
            getFile: vi.fn().mockRejectedValue(new Error('Access denied')),
          },
        ],
        [
          'fail2.txt',
          {
            ...mockFileHandle,
            getFile: vi.fn().mockRejectedValue(new Error('Access denied')),
          },
        ],
      ];
      mockDirectoryHandle.entries = vi.fn().mockImplementation(async function* () {
        yield* mockEntries;
      });

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle));

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PartialRefreshError);
      if (error instanceof Error) {
        expect(error.message).toMatch(/Failed to refresh file tree/);
      }
    });

    it('should handle nested directory partial failures', async () => {
      // Mock a nested directory structure with mixed success/failure
      const mockNestedEntries = [
        ['success.txt', mockFileHandle],
        [
          'fail.txt',
          {
            ...mockFileHandle,
            getFile: vi.fn().mockRejectedValue(new Error('Access denied')),
          },
        ],
      ];
      const mockNestedDir = {
        kind: 'directory' as const,
        name: 'nested',
        entries: vi.fn().mockImplementation(async function* () {
          yield* mockNestedEntries;
        }),
      };

      const mockRootEntries = [
        ['root.txt', mockFileHandle],
        ['nested', mockNestedDir],
      ];
      mockDirectoryHandle.entries = vi.fn().mockImplementation(async function* () {
        yield* mockRootEntries;
      });

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle));

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      if (error instanceof PartialRefreshError) {
        expect(error.successCount).toBeGreaterThan(0);
        expect(error.failCount).toBeGreaterThan(0);
      }
    });

    it('should maintain file tree state after partial refresh', async () => {
      // Mock initial successful load
      const initialEntries = [['success.txt', mockFileHandle]];
      mockDirectoryHandle.entries = vi.fn().mockImplementation(async function* () {
        yield* initialEntries;
      });

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle));

      // Wait for initial load to complete
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Mock partial failure for refresh
      const refreshEntries = [
        ['success.txt', mockFileHandle],
        [
          'fail.txt',
          {
            ...mockFileHandle,
            getFile: vi.fn().mockRejectedValue(new Error('Access denied')),
          },
        ],
      ];
      mockDirectoryHandle.entries = vi.fn().mockImplementation(async function* () {
        yield* refreshEntries;
      });

      // Attempt refresh
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      // Verify tree still contains successful files
      expect(result.current.fileTree).toHaveLength(1);
      expect(result.current.fileTree[0]).toBeDefined();
      expect(result.current.fileTree[0]!.name).toBe('success.txt');
    });
  });
});
