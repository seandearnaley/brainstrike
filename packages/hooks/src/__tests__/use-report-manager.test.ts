import { FileExplorerStrings } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReportManager } from '../use-report-manager';

// Mock file-saver
vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

describe('useReportManager', () => {
  // Mock dependencies
  const mockRootDirectoryHandle = {} as FileSystemDirectoryHandle;
  const mockGenerateReportWithContent = vi.fn();
  const mockShowToast = vi.fn();
  const mockToast = vi.fn();
  const mockDismiss = vi.fn();

  // Define the toast props type
  type ToastProps = {
    title: string;
    description: string;
    variant?: 'default' | 'destructive';
  };

  // Helper function to match the interface expected by the hook
  function showToast(props: ToastProps) {
    mockShowToast(props);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default mock return values
    mockToast.mockReturnValue({ dismiss: mockDismiss });
    mockGenerateReportWithContent.mockResolvedValue('Test Report Content');
    // Mock navigator.clipboard.writeText
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      writable: true,
    });
  });

  it('should handle report generation success', async () => {
    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToast,
      })
    );

    // Test the internal handleGenerateReport function via handleCopyReport
    await act(async () => {
      await result.current.handleCopyReport();
    });

    // Should call the report generation function
    expect(mockGenerateReportWithContent).toHaveBeenCalledTimes(1);
    // Should dismiss the loading toast
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    // Should show a success toast
    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.success.title,
      description: FileExplorerStrings.success.reportCopied,
    });
    // Should call clipboard.writeText with the report content
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Test Report Content');
  });

  it('should handle error when no root directory is provided', async () => {
    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: null,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyReport();
    });

    // Should show an error toast
    expect(mockToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.error.title,
      description: FileExplorerStrings.error.noRootDirectory,
      variant: 'destructive',
    });
    // Should not call report generation
    expect(mockGenerateReportWithContent).not.toHaveBeenCalled();
  });

  it('should handle error during report generation', async () => {
    mockGenerateReportWithContent.mockRejectedValue(new Error('gen fail'));

    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyReport();
    });

    expect(mockToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.error.title,
      description: FileExplorerStrings.error.reportGenerationFailed,
      variant: 'destructive',
    });
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('should handle error during clipboard copy', async () => {
    // Mock clipboard.writeText to fail
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('Clipboard error')),
      },
      writable: true,
    });

    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyReport();
    });

    // Should dismiss the loading toast
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    // Should show an error toast
    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.error.title,
      description: `${FileExplorerStrings.error.reportCopyFailed}: Clipboard error`,
      variant: 'destructive',
    });
  });

  it('should handle download report', async () => {
    const { saveAs } = await import('file-saver');

    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadReport();
    });

    // Should call the report generation function
    expect(mockGenerateReportWithContent).toHaveBeenCalledTimes(1);
    // Should call saveAs with the right parameters
    expect(saveAs).toHaveBeenCalledTimes(1);
    // First argument should be a Blob with the report content
    const mockSaveAs = saveAs as unknown as {
      mock: { calls: Array<unknown[]> };
    };

    // Check the arguments passed to saveAs
    const firstCallArgs = mockSaveAs.mock.calls[0];
    expect(firstCallArgs).toBeDefined(); // Ensure the first call exists

    const blobArgument = firstCallArgs?.[0];
    expect(blobArgument).toBeInstanceOf(Blob); // Assert the first argument is a Blob

    // Check Blob type, allowing for charset (now safely typed)
    if (blobArgument instanceof Blob) {
      expect(blobArgument.type).toEqual(expect.stringContaining('text/plain'));
    } else {
      // Should not happen if the above expect passed, but satisfies TS
      throw new Error('Expected first argument to be a Blob');
    }

    // Check the filename argument
    const filenameArgument = firstCallArgs?.[1];
    expect(filenameArgument).toBe(FileExplorerStrings.fileNames.report);
  });

  it('should not download if report generation fails', async () => {
    mockGenerateReportWithContent.mockResolvedValue(null);
    const { saveAs } = await import('file-saver');

    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadReport();
    });

    // Should not call saveAs if no report is generated
    expect(saveAs).not.toHaveBeenCalled();
  });
});
