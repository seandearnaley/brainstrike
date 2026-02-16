import { FileExplorerStrings } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReportManager } from '../use-report-manager';

// Mock file-saver
vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

describe('useReportManager', () => {
  // Mock dependencies
  const mockRootDirectoryHandle = {
    name: 'Sample Project',
  } as FileSystemDirectoryHandle;
  const mockGenerateReportWithContent = vi.fn();
  const mockShowToast = vi.fn();
  const mockToast = vi.fn();
  const mockDismiss = vi.fn();

  // Define the toast props type
  interface ToastProps {
    title: string;
    description: string;
    variant?: 'default' | 'destructive';
  }

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

  afterEach(() => {
    vi.useRealTimers();
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
    expect(mockDismiss).toHaveBeenCalledTimes(1);
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

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-08T18:03:18.000Z'));

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
      mock: { calls: unknown[][] };
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
    expect(filenameArgument).toBe('context-Sample-Project-2025-06-08_18-03-18Z.txt');
    // Should show a success toast
    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.success.title,
      description: FileExplorerStrings.success.reportDownloaded,
    });
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
    // Should not show a success toast
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('shows an error toast when download save fails', async () => {
    const { saveAs } = await import('file-saver');
    const mockSaveAs = saveAs as unknown as { mockImplementationOnce: (fn: () => never) => void };
    mockSaveAs.mockImplementationOnce(() => {
      throw new Error('disk full');
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
      await result.current.handleDownloadReport();
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.error.title,
      description: `${FileExplorerStrings.error.contextGenerationFailed}: disk full`,
      variant: 'destructive',
    });
  });

  it('should handle toast with no return value', async () => {
    const mockToastNoReturn = vi.fn();

    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToastNoReturn,
      })
    );

    await act(async () => {
      await result.current.handleCopyReport();
    });

    expect(mockGenerateReportWithContent).toHaveBeenCalled();
    expect(mockToastNoReturn).toHaveBeenCalledWith({
      title: FileExplorerStrings.loading.generatingReport,
      description: FileExplorerStrings.prompts.waitForReport,
      duration: Number.POSITIVE_INFINITY,
    });
    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.success.title,
      description: FileExplorerStrings.success.reportCopied,
    });
  });

  it('should handle missing dismiss method gracefully', async () => {
    const mockToastNoDismiss = vi.fn().mockReturnValue({});

    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToastNoDismiss,
      })
    );

    await act(async () => {
      await result.current.handleCopyReport();
    });

    // Should handle missing dismiss gracefully
    expect(mockGenerateReportWithContent).toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.success.title,
      description: FileExplorerStrings.success.reportCopied,
    });
  });

  it('should handle undefined dismiss method on download', async () => {
    const mockToastNoDismiss = vi.fn().mockReturnValue({});

    const { result } = renderHook(() =>
      useReportManager({
        rootDirectoryHandle: mockRootDirectoryHandle,
        generateReportWithContent: mockGenerateReportWithContent,
        showToast,
        toast: mockToastNoDismiss,
      })
    );

    await act(async () => {
      await result.current.handleDownloadReport();
    });

    expect(mockGenerateReportWithContent).toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.success.title,
      description: FileExplorerStrings.success.reportDownloaded,
    });
  });

  it('should pass error message in description when copy fails', async () => {
    const errorMessage = 'Custom clipboard error';
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error(errorMessage)),
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

    expect(mockShowToast).toHaveBeenCalledWith({
      title: FileExplorerStrings.error.title,
      description: `${FileExplorerStrings.error.reportCopyFailed}: ${errorMessage}`,
      variant: 'destructive',
    });
  });
});
