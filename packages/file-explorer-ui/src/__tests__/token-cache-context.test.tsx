import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTokenCacheWorkerInitErrorsForTests,
  TokenCacheProvider,
  useOptionalTokenCacheContext,
  useTokenCacheContext,
} from '../indexing/token-cache-context';

// Mock dependencies
vi.mock('@brainstrike/preferences/stores/token-preferences-store', () => ({
  useTokenPreferencesStore: vi.fn(() => false),
  tokenPreferencesSelectors: { accurateCounting: {} },
}));

vi.mock('@brainstrike/token-cache/cache-runtime', () => ({
  // createTokenCacheWorkerPool is now async, return a Promise
  createTokenCacheWorkerPool: vi.fn(() =>
    Promise.resolve({
      exec: vi.fn().mockResolvedValue({ tokenCount: 42 }),
      terminate: vi.fn().mockResolvedValue(undefined),
    })
  ),
  FileHasher: class {
    init = vi.fn().mockResolvedValue(undefined);
  },
  TokenCacheStore: class {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
  },
  useTokenCache: vi.fn(() => ({
    getTokenCount: (_folderId: string, _filePath: string) => 100,
    getFileSize: (_folderId: string, _filePath: string) => 1024,
    getTotalTokens: async () => 100,
    isLoading: () => false,
    isAnyLoading: false,
    queueForCounting: vi.fn(),
    preloadFolder: vi.fn(),
    clearHotCache: vi.fn(),
    invalidate: vi.fn(),
    updateHotCache: vi.fn(),
    updateFileSizeCache: vi.fn(),
    cacheVersion: 1,
  })),
}));

vi.mock('../indexing/resolve-token-cache-worker-url', () => ({
  resolveTokenCacheWorkerUrlHref: vi.fn(() => 'file:///mock-worker.js'),
}));

describe('TokenCacheContext', () => {
  afterEach(() => {
    vi.clearAllMocks();
    __resetTokenCacheWorkerInitErrorsForTests();
  });

  it('provides token cache context when within provider', async () => {
    const db = { query: vi.fn() } as any;

    const TestComponent = () => {
      const { getTokenCount, isReady } = useTokenCacheContext();
      if (!isReady) {
        return <div>Loading...</div>;
      }
      return <div>Count: {getTokenCount('root', '/foo.ts')}</div>;
    };

    render(
      <TokenCacheProvider db={db}>
        <TestComponent />
      </TokenCacheProvider>
    );

    expect(await screen.findByText(/Count: 100/i)).toBeInTheDocument();
  });

  it('throws error when used outside provider', () => {
    const TestComponent = () => {
      useTokenCacheContext();
      return null;
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestComponent />)).toThrow(
      'useTokenCacheContext must be used within a TokenCacheProvider'
    );
    consoleSpy.mockRestore();
  });

  it('returns null when used with useOptionalTokenCacheContext outside provider', () => {
    const { result } = renderHook(() => useOptionalTokenCacheContext());
    expect(result.current).toBeNull();
  });

  it('initializes persistent store when db is provided', async () => {
    const db = { query: vi.fn() } as any;
    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={db}>{children}</TokenCacheProvider>,
    });
    // Wait for effects to run and set isReady to true
    await waitFor(() => expect(result.current.isReady).toBe(true));
  });

  it('provides a working countTextTokens function', async () => {
    const db = { query: vi.fn() } as any;
    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={db}>{children}</TokenCacheProvider>,
    });

    await waitFor(() => expect(result.current.isWorkerReady).toBe(true));
    const count = await result.current.countTextTokens('hello world');
    expect(count).toBeGreaterThan(0);
  });

  it('uses fallback store when no db is provided', () => {
    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
    });

    expect(result.current.store).toBeDefined();
    const store = result.current.store as any;
    expect(store.set).toBeDefined();
    expect(store.get).toBeDefined();
  });

  it('reuses the persistent store when the db wrapper object changes but query stays the same', async () => {
    const query = vi.fn();
    let currentDb = { query } as any;

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TokenCacheProvider db={currentDb}>{children}</TokenCacheProvider>
    );

    const { result, rerender } = renderHook(() => useTokenCacheContext(), { wrapper });
    await waitFor(() => expect(result.current.isPersisted).toBe(true));

    const initialStore = result.current.store;

    currentDb = { query };
    rerender();

    await waitFor(() => expect(result.current.isPersisted).toBe(true));
    expect(result.current.store).toBe(initialStore);
  });

  describe('two-tier readiness semantics (BST-150)', () => {
    it('is operational but not persisted when db is null', async () => {
      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      // Wait for worker + hasher to initialize (isOperational)
      await waitFor(() => expect(result.current.isOperational).toBe(true));

      // Without DB, persistence is not available
      expect(result.current.isPersisted).toBe(false);
      expect(result.current.persistenceMode).toBe('memory');
      // isReady (deprecated) equals isPersisted
      expect(result.current.isReady).toBe(false);
    });

    it('is both operational and persisted when db is provided', async () => {
      const db = { query: vi.fn() } as any;
      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={db}>{children}</TokenCacheProvider>,
      });

      // Wait for full initialization
      await waitFor(() => expect(result.current.isPersisted).toBe(true));

      expect(result.current.isOperational).toBe(true);
      expect(result.current.isPersisted).toBe(true);
      expect(result.current.persistenceMode).toBe('persistent');
      expect(result.current.isReady).toBe(true);
    });

    it('enables token counting when operational (even without persistence)', async () => {
      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      // Wait for operational state
      await waitFor(() => expect(result.current.isOperational).toBe(true));

      // Token counting should work via mocked useTokenCache
      const count = result.current.getTokenCount('folder', '/file.ts');
      expect(count).toBe(100); // From mock
    });

    it('exposes persistenceMode correctly', async () => {
      // Test memory mode (no DB)
      const { result: resultNoDb } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });
      await waitFor(() => expect(resultNoDb.current.isOperational).toBe(true));
      expect(resultNoDb.current.persistenceMode).toBe('memory');

      // Test persistent mode (with DB)
      const db = { query: vi.fn() } as any;
      const { result: resultWithDb } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={db}>{children}</TokenCacheProvider>,
      });
      await waitFor(() => expect(resultWithDb.current.isPersisted).toBe(true));
      expect(resultWithDb.current.persistenceMode).toBe('persistent');
    });
  });

  describe('worker warmup handshake', () => {
    it('sets workerReady after successful warmup', async () => {
      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      // Initially not ready
      expect(result.current.isWorkerReady).toBe(false);

      // Wait for warmup to complete
      await waitFor(() => expect(result.current.isWorkerReady).toBe(true));
      expect(result.current.isOperational).toBe(true);
    });

    it('does not tear down the eager worker when readiness flips during warmup', async () => {
      const { createTokenCacheWorkerPool } = await import('@brainstrike/token-cache/cache-runtime');
      const terminate = vi.fn().mockResolvedValue(undefined);
      const mockedCreatePool = vi.mocked(createTokenCacheWorkerPool);
      const defaultImplementation = mockedCreatePool.getMockImplementation();
      const exec = vi.fn().mockResolvedValue({ tokenCount: 42 });

      mockedCreatePool.mockImplementation(
        () =>
          Promise.resolve({
            exec,
            terminate,
          }) as never
      );

      try {
        const { result } = renderHook(() => useTokenCacheContext(), {
          wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
        });

        await waitFor(() => expect(result.current.isWorkerReady).toBe(true));
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(result.current.isWorkerReady).toBe(true);
        expect(mockedCreatePool).toHaveBeenCalledTimes(1);
        expect(terminate).not.toHaveBeenCalled();
      } finally {
        mockedCreatePool.mockImplementation(
          defaultImplementation ??
            (() =>
              Promise.resolve({
                exec: vi.fn().mockResolvedValue({ tokenCount: 42 }),
                terminate: vi.fn().mockResolvedValue(undefined),
              }) as never)
        );
      }
    });

    it('keeps worker mode disabled when warmup fails', async () => {
      const { createTokenCacheWorkerPool } = await import('@brainstrike/token-cache/cache-runtime');
      const mockExec = vi.fn().mockRejectedValue(new Error('Worker error'));
      const mockedCreatePool = vi.mocked(createTokenCacheWorkerPool);
      const defaultImplementation = mockedCreatePool.getMockImplementation();
      mockedCreatePool.mockImplementation(
        () =>
          Promise.resolve({
            exec: mockExec,
            terminate: vi.fn().mockResolvedValue(undefined),
          }) as any
      );

      try {
        const { result } = renderHook(() => useTokenCacheContext(), {
          wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
        });

        await waitFor(() => expect(mockExec.mock.calls.length).toBeGreaterThanOrEqual(3), {
          timeout: 2000,
        });
        await expect(result.current.countTextTokens('hello world')).rejects.toThrow(
          'Token cache worker warmup failed after 3 attempts: Worker error'
        );
        expect(mockExec.mock.calls.length).toBe(3);
      } finally {
        mockedCreatePool.mockImplementation(
          defaultImplementation ??
            (() =>
              Promise.resolve({
                exec: vi.fn().mockResolvedValue({ tokenCount: 42 }),
                terminate: vi.fn().mockResolvedValue(undefined),
              }) as any)
        );
      }
    });

    it('reuses the terminal worker init error instead of recreating the pool after a failure', async () => {
      const { createTokenCacheWorkerPool } = await import('@brainstrike/token-cache/cache-runtime');
      const mockExec = vi.fn().mockRejectedValue(new Error('Worker error'));
      const mockedCreatePool = vi.mocked(createTokenCacheWorkerPool);
      const defaultImplementation = mockedCreatePool.getMockImplementation();
      mockedCreatePool.mockImplementation(
        () =>
          Promise.resolve({
            exec: mockExec,
            terminate: vi.fn().mockResolvedValue(undefined),
          }) as never
      );

      try {
        const firstRender = renderHook(() => useTokenCacheContext(), {
          wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
        });

        await expect(firstRender.result.current.countTextTokens('hello world')).rejects.toThrow(
          'Token cache worker warmup failed after 3 attempts: Worker error'
        );
        expect(mockedCreatePool).toHaveBeenCalledTimes(1);

        firstRender.unmount();

        const secondRender = renderHook(() => useTokenCacheContext(), {
          wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
        });

        await expect(secondRender.result.current.countTextTokens('hello again')).rejects.toThrow(
          'Token cache worker warmup failed after 3 attempts: Worker error'
        );
        expect(mockedCreatePool).toHaveBeenCalledTimes(1);
      } finally {
        mockedCreatePool.mockImplementation(
          defaultImplementation ??
            (() =>
              Promise.resolve({
                exec: vi.fn().mockResolvedValue({ tokenCount: 42 }),
                terminate: vi.fn().mockResolvedValue(undefined),
              }) as never)
        );
      }
    });

    it('keeps lazy token counting disabled until the worker is actually requested', async () => {
      const { createTokenCacheWorkerPool } = await import('@brainstrike/token-cache/cache-runtime');

      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => (
          <TokenCacheProvider db={null} lazyWorkerInit={true}>
            {children}
          </TokenCacheProvider>
        ),
      });

      await waitFor(() => expect(result.current.countingMode).toBe('heuristic'));
      expect(result.current.isOperational).toBe(false);
      expect(result.current.isWorkerReady).toBe(false);
      expect(vi.mocked(createTokenCacheWorkerPool)).not.toHaveBeenCalled();

      await act(async () => {
        await expect(result.current.countTextTokens('hello world')).resolves.toBeGreaterThan(0);
      });
      expect(vi.mocked(createTokenCacheWorkerPool)).toHaveBeenCalledTimes(1);
    });
  });
});
