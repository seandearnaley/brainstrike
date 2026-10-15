import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReportGenerationRequest,
  type ReportProgressEvent,
  useReportGeneration,
} from '../use-report-generation.js';

const generateReport = vi.fn();
const createReportGenerator = vi.fn(
  () =>
    async (
      request: ReportGenerationRequest,
      onProgress?: (event: ReportProgressEvent) => void
    ): Promise<string> => {
      onProgress?.({ loaded: 1, total: 1 });
      return await generateReport(
        request.selectedFiles,
        request.fileContents,
        request.rootDirectoryHandle,
        request.includeFilters,
        request.excludeFilters,
        request.useRegex,
        request.includeProjectTree,
        request.folderSummaryThreshold,
        { projectTreeUsesViewFilters: request.projectTreeUsesViewFilters ?? false }
      );
    }
);

describe('useReportGeneration', () => {
  const mockSelectedFiles = new Set<string>(['file1.ts', 'file2.ts']);
  const mockFileContents = { 'file1.ts': 'content1', 'file2.ts': 'content2' };
  const mockFileSystemAdapter = {} as FileSystemAdapter;
  const mockRootDirectoryHandle = {
    kind: 'directory',
    name: 'root',
    path: '/root',
    platform: 'web',
  } satisfies DirectoryHandle;
  const mockIncludeFilters = ['*.ts'];
  const mockExcludeFilters = ['node_modules'];
  const mockUseRegex = false;
  const mockIncludeProjectTree = true;
  const mockFolderSummaryThreshold = 5;

  // Helper to create a basic hook props object
  const createBaseProps = (overrides = {}) => ({
    createReportGenerator,
    excludeFilters: mockExcludeFilters,
    fileContents: mockFileContents,
    fileSystemAdapter: mockFileSystemAdapter,
    folderSummaryThreshold: mockFolderSummaryThreshold,
    includeFilters: mockIncludeFilters,
    includeProjectTree: mockIncludeProjectTree,
    rootDirectoryHandle: mockRootDirectoryHandle,
    selectedFiles: mockSelectedFiles,
    useRegex: mockUseRegex,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with isGenerating set to false', () => {
    const { result } = renderHook(() => useReportGeneration(createBaseProps()));

    expect(result.current.isGenerating).toBe(false);
  });

  it('should call generateReport with correct parameters', async () => {
    const mockReport = '<report>Test Report</report>';
    (generateReport as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReport);

    const { result } = renderHook(() => useReportGeneration(createBaseProps()));

    let reportResult: string | undefined;
    await act(async () => {
      reportResult = await result.current.generateContextWithContent();
    });

    expect(generateReport).toHaveBeenCalledWith(
      mockSelectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      mockIncludeFilters,
      mockExcludeFilters,
      mockUseRegex,
      mockIncludeProjectTree,
      mockFolderSummaryThreshold,
      {
        projectTreeUsesViewFilters: false,
      }
    );

    expect(reportResult).toBe(mockReport);
    expect(result.current.isGenerating).toBe(false);
  });

  it('keeps the generator callback stable while reading the latest committed inputs', async () => {
    (generateReport as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '<report>latest</report>'
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender, result } = renderHook(
      ({ hookProps, shouldThrow }) => {
        const value = useReportGeneration(hookProps);
        if (shouldThrow) {
          throw new Error('abort report hook render');
        }
        return value;
      },
      {
        initialProps: { hookProps: createBaseProps(), shouldThrow: false },
      }
    );
    const initialCallback = result.current.generateContextWithContent;
    const latestFileContents = { 'latest.ts': 'latest content' };
    const latestSelectedFiles = new Set(['latest.ts']);

    rerender({
      hookProps: createBaseProps({
        fileContents: latestFileContents,
        selectedFiles: latestSelectedFiles,
      }),
      shouldThrow: false,
    });

    expect(result.current.generateContextWithContent).toBe(initialCallback);
    try {
      expect(() =>
        rerender({
          hookProps: createBaseProps({
            fileContents: { 'aborted.ts': 'must not leak' },
            selectedFiles: new Set(['aborted.ts']),
          }),
          shouldThrow: true,
        })
      ).toThrow('abort report hook render');

      await act(async () => {
        await initialCallback();
      });
      expect(generateReport).toHaveBeenCalledWith(
        latestSelectedFiles,
        latestFileContents,
        mockRootDirectoryHandle,
        mockIncludeFilters,
        mockExcludeFilters,
        mockUseRegex,
        mockIncludeProjectTree,
        mockFolderSummaryThreshold,
        { projectTreeUsesViewFilters: false }
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('should set isGenerating to true while generating the report', async () => {
    // Use a mock implementation that allows us to control when the promise resolves
    // and check the state during execution
    let resolvePromise: ((value: string) => void) | undefined;

    // Create a promise that we can manually resolve
    const delayedPromise = new Promise<string>((resolve) => {
      resolvePromise = resolve;
    });

    // Mock implementation that allows us to check the state during execution
    (generateReport as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // Return our controlled promise
      return delayedPromise;
    });

    const { result } = renderHook(() => useReportGeneration(createBaseProps()));

    // Start the report generation process but don't await its completion
    let generatePromise: Promise<string | undefined>;

    await act(async () => {
      // Start the generation process
      generatePromise = result.current.generateContextWithContent();
    });

    // Check the state right after starting (should be generating)
    expect(result.current.isGenerating).toBe(true);

    // Now complete the operation
    await act(async () => {
      if (resolvePromise) {
        resolvePromise('test report');
      }
      // Wait for the generateContextWithContent promise to resolve
      await generatePromise;
    });

    // After completion, isGenerating should be false
    expect(result.current.isGenerating).toBe(false);
  });

  it('should throw an error if no root directory handle is provided', async () => {
    const { result } = renderHook(() =>
      useReportGeneration(createBaseProps({ rootDirectoryHandle: undefined }))
    );

    await expect(result.current.generateContextWithContent()).rejects.toThrow(
      'No root directory selected'
    );
  });

  it('should set isGenerating to false even if report generation fails', async () => {
    (generateReport as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Test error')
    );

    const { result } = renderHook(() => useReportGeneration(createBaseProps()));

    await act(async () => {
      try {
        await result.current.generateContextWithContent();
      } catch {
        // Expected error
      }
    });

    expect(result.current.isGenerating).toBe(false);
  });

  describe('loadMissingContent integration', () => {
    it('should call loadMissingContent for files without content', async () => {
      const mockReport = '<report>Test Report with loaded content</report>';
      (generateReport as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReport);

      // Start with empty file contents - simulating lazy loading scenario
      const emptyFileContents: Record<string, string> = {};
      const loadedContents = { 'file1.ts': 'loaded-content1', 'file2.ts': 'loaded-content2' };

      const mockLoadMissingContent = vi.fn().mockResolvedValue(undefined);
      const mockGetFileContents = vi.fn().mockReturnValue(loadedContents);

      const { result } = renderHook(() =>
        useReportGeneration(
          createBaseProps({
            fileContents: emptyFileContents,
            getFileContents: mockGetFileContents,
            loadMissingContent: mockLoadMissingContent,
          })
        )
      );

      await act(async () => {
        await result.current.generateContextWithContent();
      });

      // Should have called loadMissingContent with both files
      expect(mockLoadMissingContent).toHaveBeenCalledTimes(1);
      expect(mockLoadMissingContent).toHaveBeenCalledWith(['file1.ts', 'file2.ts']);

      // Should have called getFileContents to get fresh content after loading
      expect(mockGetFileContents).toHaveBeenCalled();

      // generateReport should receive the loaded contents
      expect(generateReport).toHaveBeenCalledWith(
        mockSelectedFiles,
        loadedContents,
        mockRootDirectoryHandle,
        mockIncludeFilters,
        mockExcludeFilters,
        mockUseRegex,
        mockIncludeProjectTree,
        mockFolderSummaryThreshold,
        {
          projectTreeUsesViewFilters: false,
        }
      );
    });

    it('should only load missing files, not files that already have content', async () => {
      const mockReport = '<report>Partial load report</report>';
      (generateReport as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReport);

      // One file has content, one doesn't
      const partialFileContents = { 'file1.ts': 'existing-content1' };
      const loadedContents = {
        'file1.ts': 'existing-content1',
        'file2.ts': 'newly-loaded-content2',
      };

      const mockLoadMissingContent = vi.fn().mockResolvedValue(undefined);
      const mockGetFileContents = vi.fn().mockReturnValue(loadedContents);

      const { result } = renderHook(() =>
        useReportGeneration(
          createBaseProps({
            fileContents: partialFileContents,
            getFileContents: mockGetFileContents,
            loadMissingContent: mockLoadMissingContent,
          })
        )
      );

      await act(async () => {
        await result.current.generateContextWithContent();
      });

      // Should only load the missing file (file2.ts)
      expect(mockLoadMissingContent).toHaveBeenCalledTimes(1);
      expect(mockLoadMissingContent).toHaveBeenCalledWith(['file2.ts']);
    });

    it('should not call loadMissingContent when all files have content', async () => {
      const mockReport = '<report>All content present</report>';
      (generateReport as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReport);

      // All files already have content
      const completeFileContents = { 'file1.ts': 'content1', 'file2.ts': 'content2' };
      const mockLoadMissingContent = vi.fn().mockResolvedValue(undefined);
      const mockGetFileContents = vi.fn();

      const { result } = renderHook(() =>
        useReportGeneration(
          createBaseProps({
            fileContents: completeFileContents,
            getFileContents: mockGetFileContents,
            loadMissingContent: mockLoadMissingContent,
          })
        )
      );

      await act(async () => {
        await result.current.generateContextWithContent();
      });

      // Should not call loadMissingContent since all files have content
      expect(mockLoadMissingContent).not.toHaveBeenCalled();
      // Should not call getFileContents since no loading was needed
      expect(mockGetFileContents).not.toHaveBeenCalled();

      // generateReport should use the original file contents
      expect(generateReport).toHaveBeenCalledWith(
        mockSelectedFiles,
        completeFileContents,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          projectTreeUsesViewFilters: false,
        }
      );
    });

    it('should use original fileContents when getFileContents is not provided', async () => {
      const mockReport = '<report>Fallback to original</report>';
      (generateReport as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReport);

      const emptyFileContents: Record<string, string> = {};
      const mockLoadMissingContent = vi.fn().mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useReportGeneration(
          createBaseProps({
            fileContents: emptyFileContents,
            loadMissingContent: mockLoadMissingContent,
            // getFileContents intentionally not provided
          })
        )
      );

      await act(async () => {
        await result.current.generateContextWithContent();
      });

      // Should still call loadMissingContent
      expect(mockLoadMissingContent).toHaveBeenCalled();

      // generateReport should receive original (empty) fileContents as fallback
      expect(generateReport).toHaveBeenCalledWith(
        mockSelectedFiles,
        emptyFileContents,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          projectTreeUsesViewFilters: false,
        }
      );
    });

    it('should work without loadMissingContent (backward compatibility)', async () => {
      const mockReport = '<report>No loader provided</report>';
      (generateReport as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReport);

      // No loadMissingContent provided - simulating old behavior
      const { result } = renderHook(() =>
        useReportGeneration(
          createBaseProps({
            fileContents: mockFileContents,
            // No loadMissingContent or getFileContents
          })
        )
      );

      await act(async () => {
        await result.current.generateContextWithContent();
      });

      // Should work and use the provided fileContents directly
      expect(generateReport).toHaveBeenCalledWith(
        mockSelectedFiles,
        mockFileContents,
        mockRootDirectoryHandle,
        mockIncludeFilters,
        mockExcludeFilters,
        mockUseRegex,
        mockIncludeProjectTree,
        mockFolderSummaryThreshold,
        {
          projectTreeUsesViewFilters: false,
        }
      );
    });

    it('should handle loadMissingContent errors gracefully', async () => {
      const mockLoadMissingContent = vi.fn().mockRejectedValue(new Error('Load failed'));

      const { result } = renderHook(() =>
        useReportGeneration(
          createBaseProps({
            fileContents: {},
            loadMissingContent: mockLoadMissingContent,
          })
        )
      );

      // Should propagate the error
      await expect(
        act(async () => {
          await result.current.generateContextWithContent();
        })
      ).rejects.toThrow('Load failed');

      // isGenerating should be reset to false
      expect(result.current.isGenerating).toBe(false);
    });
  });
});
