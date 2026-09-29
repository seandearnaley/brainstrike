import { FileExplorerStrings } from '@brainstrike/types';
import { downloadBlobFile } from '@brainstrike/utils/browser-download';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReportManager } from '../use-report-manager.js';

// Mock only the save half of the shared download path; the filename half stays
// real so these tests pin the actual on-disk name.
vi.mock('@brainstrike/utils/browser-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/utils/browser-download')>()),
  downloadBlobFile: vi.fn(),
}));

const mockDownloadBlobFile = vi.mocked(downloadBlobFile);

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
    mockDownloadBlobFile.mockResolvedValue({});
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

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleCopyContext();
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
    expect(outcome).toEqual({ ok: true });
  });

  it('should handle error when no root directory is provided', async () => {
    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: null,
        toast: mockToast,
      })
    );

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleCopyContext();
    });

    // Should show an error toast
    expect(mockToast).toHaveBeenCalledWith({
      description: FileExplorerStrings.error.noRootDirectory,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
    // Should not call context generation
    expect(mockGenerateContextWithContent).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: 'root-unavailable', retryable: false });
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

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleCopyContext();
    });

    expect(mockToast).toHaveBeenCalledWith({
      description: FileExplorerStrings.error.contextGenerationFailed,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(clipboardMocks.writeText).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: 'generation-failed', retryable: true });
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

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleCopyContext();
    });

    // Should dismiss the loading toast
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    // Should show an error toast
    expect(mockToast).toHaveBeenCalledWith({
      description: `${FileExplorerStrings.error.contextCopyFailed}: Clipboard error`,
      title: FileExplorerStrings.error.title,
      variant: 'destructive',
    });
    expect(outcome).toEqual({ ok: false, reason: 'action-failed', retryable: true });
  });

  it('returns a truthful failure outcome when the download action rejects', async () => {
    mockDownloadBlobFile.mockRejectedValueOnce(new Error('save bridge failed'));
    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: mockRootDirectoryHandle,
        toast: mockToast,
      })
    );

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.handleDownloadContext();
    });

    expect(outcome).toEqual({ ok: false, reason: 'action-failed', retryable: true });
    expect(mockToast).toHaveBeenCalledWith({
      description: `${FileExplorerStrings.error.contextDownloadFailed}: save bridge failed`,
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
    // Should save through the shared download path with the report content
    expect(mockDownloadBlobFile).toHaveBeenCalledTimes(1);
    expect(mockDownloadBlobFile).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      filename: 'context-Sample-Project-2025-06-08T18-03-18Z.txt',
    });
    const blobArgument = mockDownloadBlobFile.mock.calls[0]?.[0]?.blob;
    expect(blobArgument?.type).toEqual(expect.stringContaining('text/plain'));
    // Should show a success toast
    expect(mockToast).toHaveBeenCalledWith({
      description: FileExplorerStrings.success.contextDownloaded,
      title: FileExplorerStrings.success.title,
    });
  });

  it('keeps the download filename inside the desktop-safe charset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-08T18:03:18.000Z'));

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: { name: 'My Project (v2)!' } as FileSystemDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    // The desktop save bridge hard-rejects filenames outside [a-zA-Z0-9._-].
    expect(mockDownloadBlobFile).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      filename: 'context-My-Project-v2-2025-06-08T18-03-18Z.txt',
    });
  });

  it('drops a root segment that sanitizes away instead of leaving a dangling hyphen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-08T18:03:18.000Z'));

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: { name: '日本語' } as FileSystemDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    // Not `context--…`: emptiness is judged AFTER sanitizing.
    expect(mockDownloadBlobFile).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      filename: 'context-2025-06-08T18-03-18Z.txt',
    });
  });

  it('truncates a long root segment so the filename stays under the desktop bridge cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-08T18:03:18.000Z'));

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: { name: 'a'.repeat(300) } as FileSystemDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    expect(mockDownloadBlobFile).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      filename: `context-${'a'.repeat(64)}-2025-06-08T18-03-18Z.txt`,
    });
  });

  it('does not leave a trailing hyphen when truncation cuts at a separator', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-08T18:03:18.000Z'));

    const { result } = renderHook(() =>
      useReportManager({
        generateContextWithContent: mockGenerateContextWithContent,
        rootDirectoryHandle: {
          name: `${'a'.repeat(63)} ${'b'.repeat(100)}`,
        } as FileSystemDirectoryHandle,
        toast: mockToast,
      })
    );

    await act(async () => {
      await result.current.handleDownloadContext();
    });

    // 63 a's + hyphen is 64 chars; the cut lands on the hyphen, which must not survive.
    expect(mockDownloadBlobFile).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      filename: `context-${'a'.repeat(63)}-2025-06-08T18-03-18Z.txt`,
    });
  });

  it('should not download if context generation fails', async () => {
    mockGenerateContextWithContent.mockResolvedValue(null);

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

    // Should not save if no context is generated
    expect(mockDownloadBlobFile).not.toHaveBeenCalled();
  });

  it('shows an error toast when download save fails', async () => {
    mockDownloadBlobFile.mockRejectedValueOnce(new Error('disk full'));

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
      description: `${FileExplorerStrings.error.contextDownloadFailed}: disk full`,
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
