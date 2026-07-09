import { FileExplorerStrings } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReportManager } from '../use-report-manager';

// Mock file-saver
vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({
    writeText: clipboardMocks.writeText,
  }),
}));

describe('useReportManager', () => {
  // Mock dependencies
  const mockRootDirectoryHandle = {
    name: 'Sample Project',
  } as FileSystemDirectoryHandle;
  const mockGenerateContextWithContent = vi.fn();
  const mockToast = vi.fn();
  const mockDismiss = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default mock return values
    mockToast.mockReturnValue({ dismiss: mockDismiss });
    mockGenerateContextWithContent.mockResolvedValue('Test Report Content');
    clipboardMocks.writeText.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle context generation success', async () => {
    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    // Should call the context generation function
    expect(mockGenerateContextWithContent).toHaveBeenCalledTimes(1);
    // Should dismiss the loading toast
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    // Should show a success toast
    expect(mockToast).toHaveBeenCalledWith({
      description: FileExplorerStrings.success.contextCopied,
      title: FileExplorerStrings.success.title,
    });
    // Should call the shared clipboard service with the report content
    expect(clipboardMocks.writeText).toHaveBeenCalledWith('Test Report Content');
  });

  it('should handle error when no root directory is provided', async () => {
    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: null,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    // Should show an error toast
    expect(mockToast).toHaveBeenCalledWith({
      description: FileExplorerStrings.error.noRootDirectory,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
    // Should not call context generation
    expect(mockGenerateContextWithContent).not.toHaveBeenCalled();
  });

  it('should handle error during context generation', async () => {
    mockGenerateContextWithContent.mockRejectedValue(new Error('gen fail'));

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    expect(mockToast).toHaveBeenCalledWith({
      description: FileExplorerStrings.error.contextGenerationFailed,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(clipboardMocks.writeText).not.toHaveBeenCalled();
  });

  it('should handle error during clipboard copy', async () => {
    clipboardMocks.writeText.mockResolvedValue({ error: 'Clipboard error', ok: false });

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    // Should dismiss the loading toast
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    // Should show an error toast
    expect(mockToast).toHaveBeenCalledWith({
      description: `${FileExplorerStrings.error.contextCopyFailed}: Clipboard error`,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
  });

  it('surfaces a present-but-broken Electron bridge without falling back', async () => {
    clipboardMocks.writeText.mockResolvedValue({
      error: 'Desktop clipboard bridge rejected the write',
      ok: false,
    });

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    expect(clipboardMocks.writeText).toHaveBeenCalledWith('Test Report Content');
    expect(mockToast).toHaveBeenCalledWith({
      description: `${FileExplorerStrings.error.contextCopyFailed}: Desktop clipboard bridge rejected the write`,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
  });

  it('should handle download context', async () => {
    const { saveAs } = await import('file-saver');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-08T18:03:18.000Z'));

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    // Should call the context generation function
    expect(mockGenerateContextWithContent).toHaveBeenCalledTimes(1);
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
    expect(mockToast).toHaveBeenCalledWith({
      description: FileExplorerStrings.success.contextDownloaded,
      title: FileExplorerStrings.success.title,
    });
  });

  it('should not download if context generation fails', async () => {
    mockGenerateContextWithContent.mockResolvedValue(null);
    const { saveAs } = await import('file-saver');

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    // Should not call saveAs if no context is generated
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('shows an error toast when download save fails', async () => {
    const { saveAs } = await import('file-saver');
    const mockSaveAs = saveAs as unknown as { mockImplementationOnce: (fn: () => never) => void };
    mockSaveAs.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    expect(mockToast).toHaveBeenCalledWith({
      description: `${FileExplorerStrings.error.contextGenerationFailed}: disk full`,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
  });

  it('should handle toast with no return value', async () => {
    const mockToastNoReturn = vi.fn();

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToastNoReturn,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    expect(mockGenerateContextWithContent).toHaveBeenCalled();
    expect(mockToastNoReturn).toHaveBeenCalledWith({
      description: FileExplorerStrings.prompts.waitForContext,
      duration: Number.POSITIVE_INFINITY,
      title: FileExplorerStrings.loading.generatingContext,
    });
    expect(mockToastNoReturn).toHaveBeenCalledWith({
      description: FileExplorerStrings.success.contextCopied,
      title: FileExplorerStrings.success.title,
    });
  });

  it('should handle missing dismiss method gracefully', async () => {
    const mockToastNoDismiss = vi.fn().mockReturnValue({});

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToastNoDismiss,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    // Should handle missing dismiss gracefully
    expect(mockGenerateContextWithContent).toHaveBeenCalled();
    expect(mockToastNoDismiss).toHaveBeenCalledWith({
      description: FileExplorerStrings.success.contextCopied,
      title: FileExplorerStrings.success.title,
    });
  });

  it('should handle undefined dismiss method on download', async () => {
    const mockToastNoDismiss = vi.fn().mockReturnValue({});

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToastNoDismiss,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    expect(mockGenerateContextWithContent).toHaveBeenCalled();
    expect(mockToastNoDismiss).toHaveBeenCalledWith({
      description: FileExplorerStrings.success.contextDownloaded,
      title: FileExplorerStrings.success.title,
    });
  });

  it('should pass error message in description when copy fails', async () => {
    const errorMessage = 'Custom clipboard error';
    clipboardMocks.writeText.mockResolvedValue({ error: errorMessage, ok: false });

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleCopyContext();
    });

    expect(mockToast).toHaveBeenCalledWith({
      description: `${FileExplorerStrings.error.contextCopyFailed}: ${errorMessage}`,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
  });
});
