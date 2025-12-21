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

vi.mock('@brainstrike/token-cache', () => ({
  createTokenCacheWorkerPool: vi.fn(() => ({
    exec: vi.fn().mockResolvedValue({ tokenCount: 42 }),
    terminate: vi.fn().mockResolvedValue(undefined),
  })),
  FileHasher: class {
    init = vi.fn().mockResolvedValue(undefined);
  },
  TokenCacheStore: class {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
  },
  useTokenCache: vi.fn(() => ({
    getTokenCount: (_folderId: string, _filePath: string) => 100,
    getTotalTokens: async () => 100,
    isLoading: () => false,
    isAnyLoading: false,
    queueForCounting: vi.fn(),
    preloadFolder: vi.fn(),
    clearHotCache: vi.fn(),
    invalidate: vi.fn(),
    updateHotCache: vi.fn(),
    cacheVersion: 1,
  })),
}));

describe('TokenCacheContext', () => {
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
});
