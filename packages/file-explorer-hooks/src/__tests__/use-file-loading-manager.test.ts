import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileLoadingManager } from '../use-file-loading-manager';

describe('useFileLoadingManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates loading state while a file is being loaded', async () => {
    let resolveLoad: (() => void) | undefined;
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const loadFileContent = vi.fn(() => loadPromise);
    const selectedFilePaths = new Set<string>(['/test.txt']);
    const fileContents: Record<string, string> = {};

    const { result } = renderHook(() =>
      useFileLoadingManager({ fileContents, loadFileContent, selectedFilePaths })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileContent).toHaveBeenCalledWith('/test.txt');
    expect(result.current.loadingFiles.has('/test.txt')).toBe(true);

    await act(async () => {
      resolveLoad?.();
      await loadPromise;
    });

    expect(result.current.loadingFiles.has('/test.txt')).toBe(false);
  });

  it('does not load content for already loaded files', async () => {
    const loadFileContent = vi.fn().mockResolvedValue(undefined);
    const selectedFilePaths = new Set<string>(['/loaded.txt']);
    const fileContents = { '/loaded.txt': 'content' };

    renderHook(() => useFileLoadingManager({ fileContents, loadFileContent, selectedFilePaths }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileContent).not.toHaveBeenCalled();
  });

  it('triggers loading when selected files change', async () => {
    const loadFileContent = vi.fn().mockResolvedValue(undefined);
    let selectedFilePaths = new Set<string>();
    const fileContents: Record<string, string> = {};

    const { rerender } = renderHook(() =>
      useFileLoadingManager({ fileContents, loadFileContent, selectedFilePaths })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(loadFileContent).not.toHaveBeenCalled();

    const updated = new Set(selectedFilePaths);
    updated.add('/new.txt');
    selectedFilePaths = updated;
    rerender();

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileContent).toHaveBeenCalledWith('/new.txt');
  });
});
