import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEnhancedFileImportService } from '../enhanced-file-import-service';

// Mock the base service to prevent provider issues
vi.mock('../base-file-import-service', () => ({
  useFileImportService: vi.fn(() => ({
    importFiles: vi.fn(),
    isImporting: false,
    progress: null,
  })),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('useEnhancedFileImportService', () => {
  describe('Basic functionality', () => {
    it('should initialize with correct default state', () => {
      const { result } = renderHook(() => useEnhancedFileImportService());

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
    });

    it('should accept options parameter', () => {
      const options = {
        onComplete: vi.fn(),
        onError: vi.fn(),
        onProgress: vi.fn(),
      };

      const { result } = renderHook(() => useEnhancedFileImportService(options));

      expect(result.current.isImporting).toBe(false);
      expect(result.current.progress).toBe(null);
      expect(typeof result.current.importFiles).toBe('function');
    });

    it('should call base import service on importFiles', async () => {
      const mockBaseImport = vi.fn();
      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      const { result } = renderHook(() => useEnhancedFileImportService());

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(mockBaseImport).toHaveBeenCalledWith(
        new Set(['test-folder:/test/path']),
        [],
        {
          'test-folder:/test/path': 'test content',
        },
        undefined
      );
    });

    it('passes resolved embedding set id through to the base import service', async () => {
      const mockBaseImport = vi.fn();
      const baseService = await import('../base-file-import-service');
      vi.mocked(baseService.useFileImportService).mockReturnValue({
        importFiles: mockBaseImport,
        isImporting: false,
        progress: null,
      });

      const { result } = renderHook(() =>
        useEnhancedFileImportService({ resolveTargetEmbeddingSetId: () => 'set-from-test' })
      );

      await act(async () => {
        await result.current.importFiles(new Set(['test-folder:/test/path']), [], {
          'test-folder:/test/path': 'test content',
        });
      });

      expect(mockBaseImport).toHaveBeenCalledWith(
        expect.any(Set),
        expect.any(Array),
        expect.any(Object),
        'set-from-test'
      );
    });
  });
});

describe('native collection import ownership', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses the native joined counts and pending reason', async () => {
    vi.stubGlobal('sourceFiles', { import: vi.fn() });
    const baseService = await import('../base-file-import-service');
    const nativeResults = [
      {
        chunksCreated: 7,
        error: 'Collection is paused; indexing remains pending.',
        existed: false,
        id: 'canonical-source',
        imported: true,
      },
    ];
    vi.mocked(baseService.useFileImportService).mockImplementation((options) => ({
      importFiles: async () => {
        options?.onComplete?.(nativeResults);
      },
      isImporting: false,
      progress: null,
    }));
    const onComplete = vi.fn();
    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useEnhancedFileImportService({
        onComplete,
        onProgress,
        resolveTargetEmbeddingSetId: () => 'collection',
      })
    );
    await act(() =>
      result.current.importFiles(new Set(['root:note.txt']), [], { 'root:note.txt': 'hello' })
    );
    expect(onComplete).toHaveBeenCalledWith(nativeResults);
    expect(result.current.progress).toMatchObject({
      completed: 1,
      errors: [{ error: nativeResults[0]?.error, file: 'canonical-source' }],
      phase: 'complete',
    });
  });
  it('joins a committed native import before settling cancellation without replay or completion notification', async () => {
    vi.stubGlobal('sourceFiles', { import: vi.fn() });
    const baseService = await import('../base-file-import-service');
    const admitted = createDeferred<void>();
    const release = createDeferred<void>();
    const importFiles = vi.fn(async () => {
      admitted.resolve();
      await release.promise;
    });
    vi.mocked(baseService.useFileImportService).mockImplementation((options) => ({
      importFiles: async () => {
        await importFiles();
        const committed = [{ chunksCreated: 1, existed: false, id: 'retained', imported: true }];
        options?.onComplete?.(committed);
      },
      isImporting: false,
      progress: null,
    }));
    const onComplete = vi.fn();
    const { result } = renderHook(() => useEnhancedFileImportService({ onComplete }));
    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.importFiles(new Set(['root:note.txt']), [], {});
      await admitted.promise;
    });
    act(() => result.current.cancelImport());
    expect(result.current.isImporting).toBe(true);
    await act(async () => {
      release.resolve();
      await pending;
    });
    expect(importFiles).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.current.isImporting).toBe(false);
  });
  it('reports a native source writer refusal', async () => {
    vi.stubGlobal('sourceFiles', { import: vi.fn() });
    const failure = new Error('Native source write refused');
    const baseService = await import('../base-file-import-service');
    vi.mocked(baseService.useFileImportService).mockImplementation((options) => ({
      importFiles: async () => {
        options?.onError?.(failure);
      },
      isImporting: false,
      progress: null,
    }));
    const onError = vi.fn();
    const { result } = renderHook(() => useEnhancedFileImportService({ onError }));
    await act(() => result.current.importFiles(new Set(['root:note.txt']), [], {}));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(result.current.isImporting).toBe(false);
  });
});
