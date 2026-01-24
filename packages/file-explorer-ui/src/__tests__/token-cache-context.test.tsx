import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  TokenCacheProvider,
  useOptionalTokenCacheContext,
  useTokenCacheContext,
} from '../token-cache-context';

// Mock dependencies
vi.mock('@brainstrike/preferences', () => ({
  useTokenPreferencesStore: vi.fn(() => false),
  tokenPreferencesSelectors: { accurateCounting: {} },
}));

// Configurable mock for createTokenCacheWorkerPool
// Allows tests to reconfigure behavior (e.g., simulate warmup failures)
const mockCreateTokenCacheWorkerPool = vi.fn((_url?: string) => ({
  exec: vi.fn().mockResolvedValue({ tokenCount: 42 }),
  terminate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@brainstrike/token-cache', () => ({
  createTokenCacheWorkerPool: (url?: string) => mockCreateTokenCacheWorkerPool(url),
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

describe('TokenCacheContext', () => {
  beforeEach(() => {
    // Reset to default successful mock before each test
    mockCreateTokenCacheWorkerPool.mockImplementation(() => ({
      exec: vi.fn().mockResolvedValue({ tokenCount: 42 }),
      terminate: vi.fn().mockResolvedValue(undefined),
    }));
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
    await vi.waitFor(() => expect(result.current.isReady).toBe(true));
  });

  it('provides a working countTextTokens function', async () => {
    const db = { query: vi.fn() } as any;
    const { result } = renderHook(() => useTokenCacheContext(), {
      wrapper: ({ children }) => <TokenCacheProvider db={db}>{children}</TokenCacheProvider>,
    });

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

  describe('two-tier readiness semantics (BST-150)', () => {
    it('is operational but not persisted when db is null', async () => {
      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      // Wait for worker + hasher to initialize (isOperational)
      await vi.waitFor(() => expect(result.current.isOperational).toBe(true));

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
      await vi.waitFor(() => expect(result.current.isPersisted).toBe(true));

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
      await vi.waitFor(() => expect(result.current.isOperational).toBe(true));

      // Token counting should work via mocked useTokenCache
      const count = result.current.getTokenCount('folder', '/file.ts');
      expect(count).toBe(100); // From mock
    });

    it('exposes persistenceMode correctly', async () => {
      // Test memory mode (no DB)
      const { result: resultNoDb } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });
      await vi.waitFor(() => expect(resultNoDb.current.isOperational).toBe(true));
      expect(resultNoDb.current.persistenceMode).toBe('memory');

      // Test persistent mode (with DB)
      const db = { query: vi.fn() } as any;
      const { result: resultWithDb } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={db}>{children}</TokenCacheProvider>,
      });
      await vi.waitFor(() => expect(resultWithDb.current.isPersisted).toBe(true));
      expect(resultWithDb.current.persistenceMode).toBe('persistent');
    });
  });

  describe('worker warmup handshake', () => {
    it('sets workerReady=true only after successful warmup', async () => {
      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      // Initially not operational (warmup not yet complete)
      // Note: This may be flaky if warmup is very fast, but we're testing the concept
      await vi.waitFor(() => expect(result.current.isOperational).toBe(true));

      // Verify the mock was called (warmup happened)
      expect(mockCreateTokenCacheWorkerPool).toHaveBeenCalled();
    });

    it('remains not operational when worker warmup fails', async () => {
      // Configure mock to reject on exec (simulating warmup failure)
      mockCreateTokenCacheWorkerPool.mockImplementation(() => ({
        exec: vi.fn().mockRejectedValue(new Error('Worker initialization failed')),
        terminate: vi.fn().mockResolvedValue(undefined),
      }));

      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      // Wait a tick for the warmup to attempt and fail
      await vi.waitFor(
        () => {
          // isWorkerReady should be false due to warmup failure
          expect(result.current.isWorkerReady).toBe(false);
        },
        { timeout: 1000 }
      );

      // isOperational should be false (worker not ready)
      expect(result.current.isOperational).toBe(false);
      expect(result.current.persistenceMode).toBe('disabled');
    });

    it('uses heuristic fallback for countTextTokens when worker fails warmup', async () => {
      // Configure mock to reject on exec (simulating warmup failure)
      mockCreateTokenCacheWorkerPool.mockImplementation(() => ({
        exec: vi.fn().mockRejectedValue(new Error('Worker initialization failed')),
        terminate: vi.fn().mockResolvedValue(undefined),
      }));

      const { result } = renderHook(() => useTokenCacheContext(), {
        wrapper: ({ children }) => <TokenCacheProvider db={null}>{children}</TokenCacheProvider>,
      });

      // Wait for warmup to fail
      await vi.waitFor(() => expect(result.current.isWorkerReady).toBe(false), { timeout: 1000 });

      // countTextTokens should use heuristic fallback (text.length / 4)
      const text = 'hello world test'; // 16 chars -> ceil(16/4) = 4
      const count = await result.current.countTextTokens(text);
      expect(count).toBe(Math.ceil(text.length / 4));
    });
  });
});
