import type { TokenCacheEntry, TokenCountingMode } from '@brainstrike/token-cache/cache-runtime';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { TOKEN_ESTIMATOR_ID } from '@brainstrike/utils/token-counting-heuristics';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTokenCacheRekeyWipeForTests,
  __resetTokenCacheWorkerInitErrorsForTests,
  runTokenCacheRekeyWipeOnce,
  TOKEN_CACHE_REKEY_V5_MARKER,
  type TokenCacheContextValue,
  TokenCacheProvider,
  useOptionalTokenCacheContext,
  useTokenCacheContext,
} from '../indexing/token-cache-context';

const { tokenCacheStoreInstances, tokenPreferenceState } = vi.hoisted(() => ({
  tokenCacheStoreInstances: [] as { clearAll: ReturnType<typeof vi.fn> }[],
  tokenPreferenceState: { accurateCounting: false },
}));

// Mock dependencies
vi.mock('@brainstrike/preferences/stores/token-preferences-store', () => ({
  tokenPreferencesSelectors: { accurateCounting: {} },
  useTokenPreferencesStore: vi.fn(() => tokenPreferenceState.accurateCounting),
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
    clearAll = vi.fn().mockResolvedValue(0);
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);

    constructor() {
      tokenCacheStoreInstances.push(this as unknown as { clearAll: ReturnType<typeof vi.fn> });
    }
  },
  useTokenCache: vi.fn(() => ({
    cacheVersion: 1,
    clearHotCache: vi.fn(),
    getFileSize: (_folderId: string, _filePath: string) => 1024,
    getTokenCount: (_folderId: string, _filePath: string) => 100,
    getTotalTokens: async () => 100,
    invalidate: vi.fn(),
    isAnyLoading: false,
    isLoading: () => false,
    preloadFolder: vi.fn(),
    queueForCounting: vi.fn(),
    updateFileSizeCache: vi.fn(),
    updateHotCache: vi.fn(),
  })),
}));

vi.mock('../indexing/resolve-token-cache-worker-url', () => ({
  resolveTokenCacheWorkerUrlHref: vi.fn(() => 'file:///mock-worker.js'),
}));

interface TokenCacheStoreHarness {
  clearAll: () => Promise<number>;
  clearFolder: (folderId: string) => Promise<number>;
  delete: (folderId: string, filePath: string) => Promise<boolean>;
  findByCountingMode: (
    folderId: string,
    mode: TokenCountingMode,
    limit?: number
  ) => Promise<TokenCacheEntry[]>;
  get: (folderId: string, filePath: string) => Promise<TokenCacheEntry | null>;
  getAllForFolder: (folderId: string) => Promise<TokenCacheEntry[]>;
  getBatch: (folderId: string, filePaths: string[]) => Promise<Map<string, TokenCacheEntry>>;
  getStats: (folderId?: string) => Promise<{
    accurateCount: number;
    entryCount: number;
    heuristicCount: number;
    totalTokens: number;
  }>;
  getTotalTokens: (folderId: string, filePaths: string[]) => Promise<number>;
  set: (entry: TokenCacheEntry) => Promise<void>;
  setBatch: (entries: TokenCacheEntry[]) => Promise<void>;
  vacuum: () => Promise<void>;
}

function asMemoryStore(store: TokenCacheContextValue['store']): TokenCacheStoreHarness {
  return store as unknown as TokenCacheStoreHarness;
}

function createTokenCacheEntry(
  overrides: Partial<TokenCacheEntry> & Pick<TokenCacheEntry, 'filePath' | 'folderId'>
): TokenCacheEntry {
  const { filePath, folderId, ...entryOverrides } = overrides;
  return {
    contentHash: `hash:${folderId}:${filePath}`,
    countingMode: 'heuristic',
    filePath,
    fileSize: 128,
    folderId,
    modelEncoding: TOKEN_ESTIMATOR_ID,
    mtimeMs: null,
    tokenCount: 10,
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...entryOverrides,
  };
}

describe('TokenCacheContext', () => {
  afterEach(() => {
    vi.clearAllMocks();
    __resetTokenCacheWorkerInitErrorsForTests();
    __resetTokenCacheRekeyWipeForTests();
    localStorage.removeItem(TOKEN_CACHE_REKEY_V5_MARKER);
    tokenCacheStoreInstances.length = 0;
    tokenPreferenceState.accurateCounting = false;
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

  it('uses schema-compatible heuristic mode even when the legacy preference is true', async () => {
    tokenPreferenceState.accurateCounting = true;
    const { useTokenCache } = await import('@brainstrike/token-cache/cache-runtime');

    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
    });

    await waitFor(() => expect(result.current.countingMode).toBe('heuristic'));
    expect(vi.mocked(useTokenCache)).toHaveBeenLastCalledWith(
      expect.objectContaining({ countingMode: 'heuristic' })
    );
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

  it('stores and retrieves memory-mode token entries by folder and path', async () => {
    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
    });
    const store = asMemoryStore(result.current.store);
    const entry = createTokenCacheEntry({
      filePath: 'src/app.ts',
      folderId: 'workspace-1',
      tokenCount: 42,
    });

    await store.set(entry);

    await expect(store.get('workspace-1', 'src/app.ts')).resolves.toEqual(entry);
    await expect(store.get('workspace-1', 'missing.ts')).resolves.toBeNull();
  });

  it('supports memory-mode batch reads, totals, stats, and counting-mode filters', async () => {
    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
    });
    const store = asMemoryStore(result.current.store);
    const entries = [
      createTokenCacheEntry({
        filePath: 'src/a.ts',
        folderId: 'workspace-1',
        tokenCount: 7,
      }),
      createTokenCacheEntry({
        filePath: 'src/b.ts',
        folderId: 'workspace-1',
        tokenCount: 11,
      }),
      createTokenCacheEntry({
        filePath: 'src/c.ts',
        folderId: 'workspace-2',
        tokenCount: 13,
      }),
      createTokenCacheEntry({
        filePath: 'src/stale.ts',
        folderId: 'workspace-1',
        modelEncoding: 'o200k_base',
        tokenCount: 999,
      }),
    ];

    await store.setBatch(entries);

    const batch = await store.getBatch('workspace-1', [
      'src/a.ts',
      'missing.ts',
      'src/b.ts',
      'src/stale.ts',
    ]);
    expect([...batch.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    await expect(store.getAllForFolder('workspace-1')).resolves.toEqual([entries[0], entries[1]]);
    await expect(
      store.getTotalTokens('workspace-1', ['src/a.ts', 'src/b.ts', 'src/stale.ts'])
    ).resolves.toBe(18);
    await expect(store.getStats()).resolves.toEqual({
      accurateCount: 0,
      entryCount: 3,
      heuristicCount: 3,
      totalTokens: 31,
    });
    await expect(store.getStats('workspace-1')).resolves.toEqual({
      accurateCount: 0,
      entryCount: 2,
      heuristicCount: 2,
      totalTokens: 18,
    });
    await expect(store.findByCountingMode('workspace-1', 'accurate')).resolves.toEqual([]);
    await expect(store.findByCountingMode('workspace-1', 'heuristic', 1)).resolves.toEqual([
      entries[0],
    ]);
  });

  it('deletes and clears memory-mode token entries without touching other folders', async () => {
    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
    });
    const store = asMemoryStore(result.current.store);
    await store.setBatch([
      createTokenCacheEntry({ filePath: 'src/a.ts', folderId: 'workspace-1' }),
      createTokenCacheEntry({ filePath: 'src/b.ts', folderId: 'workspace-1' }),
      createTokenCacheEntry({ filePath: 'src/c.ts', folderId: 'workspace-2' }),
    ]);

    await expect(store.delete('workspace-1', 'src/a.ts')).resolves.toBe(true);
    await expect(store.delete('workspace-1', 'src/a.ts')).resolves.toBe(false);
    await expect(store.clearFolder('workspace-1')).resolves.toBe(1);
    await expect(store.getAllForFolder('workspace-1')).resolves.toEqual([]);
    await expect(store.getAllForFolder('workspace-2')).resolves.toHaveLength(1);
    await expect(store.clearAll()).resolves.toBe(1);
    await expect(store.getStats()).resolves.toEqual({
      accurateCount: 0,
      entryCount: 0,
      heuristicCount: 0,
      totalTokens: 0,
    });
    await expect(store.vacuum()).resolves.toBeUndefined();
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

  describe('RootId re-key wipe (storage v5)', () => {
    let logEntries: LogRecord[];
    let removeLogListener: () => void;

    beforeEach(() => {
      __resetTokenCacheRekeyWipeForTests();
      localStorage.removeItem(TOKEN_CACHE_REKEY_V5_MARKER);
      logEntries = [];
      removeLogListener = addLogListener((entry) => {
        logEntries.push(entry);
      });
    });

    afterEach(() => {
      removeLogListener();
    });

    it('clears the cache exactly once and sets the marker only after the clear resolves', async () => {
      let resolveClear: (removed: number) => void = () => {};
      const clearAll = vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveClear = resolve;
          })
      );

      // Concurrent invocations (StrictMode double-effect analog) must coalesce.
      const first = runTokenCacheRekeyWipeOnce({ clearAll });
      const second = runTokenCacheRekeyWipeOnce({ clearAll });

      expect(clearAll).toHaveBeenCalledTimes(1);
      // Marker must NOT be set while the clear is still in flight.
      expect(localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER)).toBeNull();

      resolveClear(3);
      await Promise.all([first, second]);

      expect(clearAll).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER)).toBe('true');
    });

    it('does not clear when the marker is already set', async () => {
      localStorage.setItem(TOKEN_CACHE_REKEY_V5_MARKER, 'true');
      const clearAll = vi.fn().mockResolvedValue(0);

      await runTokenCacheRekeyWipeOnce({ clearAll });

      expect(clearAll).not.toHaveBeenCalled();
      expect(localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER)).toBe('true');
    });

    it('logs a warning, leaves the marker unset on clear failure, and retries next boot', async () => {
      const clearAll = vi.fn().mockRejectedValue(new Error('db unavailable'));

      await runTokenCacheRekeyWipeOnce({ clearAll });

      expect(clearAll).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER)).toBeNull();
      const warnRecords = logEntries.filter((entry) => entry.level === LogLevel.WARN);
      expect(warnRecords.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(warnRecords)).toContain('db unavailable');

      // Simulate the next boot: module state resets, marker still absent → retry.
      __resetTokenCacheRekeyWipeForTests();
      clearAll.mockResolvedValue(2);

      await runTokenCacheRekeyWipeOnce({ clearAll });

      expect(clearAll).toHaveBeenCalledTimes(2);
      expect(localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER)).toBe('true');
    });

    it('runs the wipe through the persistent store when the provider gets a db', async () => {
      const db = { query: vi.fn() } as any;

      render(
        <TokenCacheProvider db={db}>
          <div />
        </TokenCacheProvider>
      );

      await waitFor(() => {
        expect(tokenCacheStoreInstances).toHaveLength(1);
        expect(tokenCacheStoreInstances[0]?.clearAll).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER)).toBe('true');
      });
    });

    it('does not wipe or set the marker when only the in-memory store is available', async () => {
      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      await waitFor(() => expect(result.current.isOperational).toBe(true));

      expect(tokenCacheStoreInstances).toHaveLength(0);
      expect(localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER)).toBeNull();
    });
  });
});
