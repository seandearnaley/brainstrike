import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deepEqual,
  escapePGliteLiveQueryFormatPercents,
  makeLiveQueryKey,
  useBrainstrikeLiveQuery,
  usePGliteLiveQuery,
} from '../src/use-live-query.js';

// Mock the database provider
vi.mock('../src/db-provider.js', () => ({
  usePGliteDatabase: vi.fn(),
}));

import { usePGliteDatabase } from '../src/db-provider.js';

describe('usePGliteLiveQuery Performance', () => {
  let mockSubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockLiveNamespace: any;

  beforeEach(() => {
    mockSubscribe = vi.fn();
    mockUnsubscribe = vi.fn();
    mockQuery = vi.fn().mockReturnValue({
      initialResults: { rows: [] },
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      refresh: vi.fn(),
    });

    mockLiveNamespace = {
      query: mockQuery,
      incrementalQuery: mockQuery,
    };

    (usePGliteDatabase as any).mockReturnValue({
      raw: {
        live: mockLiveNamespace,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function TestComponent({ params, select }: { params?: unknown[]; select?: any }) {
    usePGliteLiveQuery({
      query: 'SELECT * FROM test WHERE id = $1',
      params,
      select,
    });
    return null;
  }

  it('should not resubscribe when params array reference changes but content is identical', () => {
    const { rerender } = render(<TestComponent params={[1]} />);

    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Rerender with new array reference but same content
    rerender(<TestComponent params={[1]} />);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should not resubscribe when select function reference changes', () => {
    const select1 = (rows: any[]) => rows;
    const { rerender } = render(<TestComponent params={[1]} select={select1} />);

    expect(mockQuery).toHaveBeenCalledTimes(1);

    const select2 = (rows: any[]) => rows;
    rerender(<TestComponent params={[1]} select={select2} />);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('escapes literal percent signs before PGlite live query parameter formatting', () => {
    render(
      <PercentQueryComponent
        params={['needle']}
        query="SELECT * FROM test WHERE name LIKE '%' || $1 || '%'"
      />
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "SELECT * FROM test WHERE name LIKE '%%' || $1 || '%%'",
        params: ['needle'],
      })
    );
  });

  it('exposes the live query hook through the runtime-neutral alias', () => {
    render(<BrainstrikeLiveQueryComponent params={[1]} query="SELECT * FROM test WHERE id = $1" />);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        params: [1],
        query: 'SELECT * FROM test WHERE id = $1',
      })
    );
  });
});

function PercentQueryComponent({ params, query }: { params?: unknown[]; query: string }) {
  usePGliteLiveQuery({
    query,
    params,
  });
  return null;
}

function BrainstrikeLiveQueryComponent({ params, query }: { params?: unknown[]; query: string }) {
  useBrainstrikeLiveQuery({
    query,
    params,
  });
  return null;
}

describe('escapePGliteLiveQueryFormatPercents', () => {
  it('escapes literal percents only when live query params are present', () => {
    const query = "SELECT * FROM test WHERE name LIKE '%' || $1 || '%'";

    expect(escapePGliteLiveQueryFormatPercents(query, ['needle'])).toBe(
      "SELECT * FROM test WHERE name LIKE '%%' || $1 || '%%'"
    );
    expect(escapePGliteLiveQueryFormatPercents(query, [])).toBe(query);
    expect(escapePGliteLiveQueryFormatPercents(query, null)).toBe(query);
  });

  it('does not double-escape already escaped live query percents', () => {
    const query = "SELECT * FROM test WHERE name LIKE '%%' || $1 || '%%'";

    expect(escapePGliteLiveQueryFormatPercents(query, ['needle'])).toBe(query);
  });
});

describe('Electron Live Query', () => {
  let mockBridge: any;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset DB mock to simulate Electron (no direct PGlite)
    (usePGliteDatabase as any).mockReturnValue(null);

    mockUnsubscribe = vi.fn();
    mockBridge = {
      start: vi.fn().mockResolvedValue({ id: 123, initialResults: { rows: [] } }),
      stop: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      onUpdate: vi.fn().mockReturnValue(mockUnsubscribe),
    };

    // Mock window.electronAPI
    vi.stubGlobal('window', {
      electronAPI: {
        dbLive: mockBridge,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function TestComponent({ params }: { params?: unknown[] }) {
    usePGliteLiveQuery({
      query: 'SELECT * FROM test',
      params,
    });
    return null;
  }

  it('should use Electron bridge when PGlite is not available', async () => {
    render(<TestComponent params={[1]} />);

    // Wait for effect
    await vi.waitFor(() => {
      expect(mockBridge.start).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'SELECT * FROM test',
          params: [1],
        })
      );
    });
  });

  it('escapes literal percent signs before Electron live query start', async () => {
    render(
      <PercentQueryComponent
        params={['needle']}
        query="SELECT * FROM test WHERE name LIKE '%' || $1 || '%'"
      />
    );

    await vi.waitFor(() => {
      expect(mockBridge.start).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "SELECT * FROM test WHERE name LIKE '%%' || $1 || '%%'",
          params: ['needle'],
        })
      );
    });
  });

  it('should unsubscribe from bridge on unmount', async () => {
    const { unmount } = render(<TestComponent params={[1]} />);

    await vi.waitFor(() => {
      expect(mockBridge.start).toHaveBeenCalled();
    });

    unmount();

    await vi.waitFor(() => {
      expect(mockUnsubscribe).toHaveBeenCalled();
      expect(mockBridge.stop).toHaveBeenCalledWith(123);
    });
  });
});

describe('PGliteWorker live query leader changes', () => {
  let leaderChangeListener: (() => void) | null;
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockSubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribeLeader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    leaderChangeListener = null;
    mockSubscribe = vi.fn();
    mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
    mockUnsubscribeLeader = vi.fn();
    mockQuery = vi.fn().mockReturnValue({
      initialResults: { rows: [] },
      refresh: vi.fn().mockResolvedValue(undefined),
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
    });

    interface MockWorkerRaw {
      readonly live: {
        readonly incrementalQuery: typeof mockQuery;
        readonly query: typeof mockQuery;
      };
      readonly marker: 'worker-raw';
      onLeaderChange(this: MockWorkerRaw, listener: () => void): () => void;
    }

    const raw: MockWorkerRaw = {
      live: {
        incrementalQuery: mockQuery,
        query: mockQuery,
      },
      marker: 'worker-raw',
      onLeaderChange(listener: () => void) {
        if (this.marker !== 'worker-raw') {
          throw new Error('PGliteWorker onLeaderChange must be called with worker receiver');
        }
        leaderChangeListener = listener;
        return mockUnsubscribeLeader;
      },
    };

    (usePGliteDatabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ raw });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function WorkerLiveQueryComponent() {
    usePGliteLiveQuery({
      query: 'SELECT * FROM test',
    });
    return null;
  }

  it('resubscribes live queries after the worker leader changes', async () => {
    render(<WorkerLiveQueryComponent />);

    await vi.waitFor(() => {
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });

    if (!leaderChangeListener) {
      throw new Error('Expected PGliteWorker leader change listener to be registered');
    }

    act(() => {
      leaderChangeListener?.();
    });

    await vi.waitFor(() => {
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('Error Handling', () => {
  beforeEach(() => {
    // Make query creation fail immediately for initial load error handling.
    const mockFailingQuery = vi.fn().mockRejectedValue(new Error('Query failed'));

    const mockLiveNamespace = {
      query: mockFailingQuery,
      incrementalQuery: mockFailingQuery,
    };

    (usePGliteDatabase as any).mockReturnValue({
      raw: {
        live: mockLiveNamespace,
      },
    });
  });

  function ErrorComponent() {
    const { error } = usePGliteLiveQuery({
      query: 'SELECT * FROM fail',
    });
    return <div>{error ? error.message : 'No error'}</div>;
  }

  it('should catch and expose subscription errors', async () => {
    const { findByText } = render(<ErrorComponent />);
    expect(await findByText('Query failed')).toBeDefined();
  });
});

describe('usePGliteLiveQuery clearOnDisable', () => {
  let mockSubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSubscribe = vi.fn();
    mockUnsubscribe = vi.fn();
    mockQuery = vi.fn().mockReturnValue({
      initialResults: { rows: [{ id: 1 }, { id: 2 }] },
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      refresh: vi.fn(),
    });

    (usePGliteDatabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      raw: {
        live: {
          query: mockQuery,
          incrementalQuery: mockQuery,
        },
      },
    });
  });

  function ToggleEnabledComponent({
    clearOnDisable,
    enabled,
  }: {
    clearOnDisable?: boolean;
    enabled: boolean;
  }) {
    const { rows } = usePGliteLiveQuery({
      query: 'SELECT * FROM test',
      enabled,
      clearOnDisable,
    });
    return <div>{rows.length}</div>;
  }

  it('retains the last rows when disabled by default', async () => {
    const { rerender, container } = render(<ToggleEnabledComponent enabled={true} />);

    await vi.waitFor(() => {
      expect(container.textContent).toBe('2');
    });

    rerender(<ToggleEnabledComponent enabled={false} />);

    await vi.waitFor(() => {
      expect(container.textContent).toBe('2');
    });
  });

  it('clears retained rows when disabled and clearOnDisable is true', async () => {
    const { rerender, container } = render(
      <ToggleEnabledComponent clearOnDisable={true} enabled={true} />
    );

    await vi.waitFor(() => {
      expect(container.textContent).toBe('2');
    });

    rerender(<ToggleEnabledComponent clearOnDisable={true} enabled={false} />);

    await vi.waitFor(() => {
      expect(container.textContent).toBe('0');
    });
  });
});

describe('useStableParams (JSON strategy - default)', () => {
  let mockSubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSubscribe = vi.fn();
    mockUnsubscribe = vi.fn();
    mockQuery = vi.fn().mockReturnValue({
      initialResults: { rows: [] },
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      refresh: vi.fn(),
    });

    (usePGliteDatabase as any).mockReturnValue({
      raw: {
        live: {
          query: mockQuery,
          incrementalQuery: mockQuery,
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function StableParamsComponent({
    compareParams,
    params,
  }: {
    compareParams?: 'json' | 'deep';
    params?: unknown[];
  }) {
    usePGliteLiveQuery({
      query: 'SELECT * FROM test WHERE id = $1',
      params,
      compareParams,
    });
    return null;
  }

  it('should not resubscribe when primitive array content is identical (JSON default)', () => {
    const { rerender } = render(<StableParamsComponent params={[1, 'hello', true]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent params={[1, 'hello', true]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should resubscribe when array values change', () => {
    const { rerender } = render(<StableParamsComponent params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent params={[2]} />);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('should handle undefined params correctly', () => {
    const { rerender } = render(<StableParamsComponent params={undefined} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent params={undefined} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should stabilize empty arrays', () => {
    const { rerender } = render(<StableParamsComponent params={[]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent params={[]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should use deepEqual when compareParams is "deep"', () => {
    const { rerender } = render(
      <StableParamsComponent compareParams="deep" params={[1, 'hello']} />
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent compareParams="deep" params={[1, 'hello']} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should use deepEqual semantics for non-JSON-safe values', () => {
    const date = new Date('2024-01-01');
    const { rerender } = render(<StableParamsComponent compareParams="deep" params={[date]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Same date value, new object — deepEqual returns true, should not resubscribe
    rerender(<StableParamsComponent compareParams="deep" params={[new Date('2024-01-01')]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should not crash when JSON strategy encounters BigInt params', () => {
    // BigInt throws on JSON.stringify — useStableParams falls back to deepEqual
    const { rerender } = render(<StableParamsComponent params={[BigInt(1)]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent params={[BigInt(1)]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should resubscribe when params change from serializable to BigInt and back', () => {
    const { rerender } = render(<StableParamsComponent params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent params={[BigInt(1)]} />);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Returning to serializable must detect the change despite stale keyRef
    rerender(<StableParamsComponent params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('should resubscribe when params change from undefined to BigInt and back to undefined', () => {
    const { rerender } = render(<StableParamsComponent params={undefined} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<StableParamsComponent params={[BigInt(1)]} />);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // undefined → '' key; sentinel must differ so this transition is detected
    rerender(<StableParamsComponent params={undefined} />);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

describe('deepEqual', () => {
  it('should return true for identical primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it('should return false for different primitives', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(1, '1')).toBe(false);
  });

  it('should handle type mismatches correctly', () => {
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual(new Date(), {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it('should compare arrays correctly', () => {
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });

  it('should compare Dates correctly', () => {
    const now = new Date();
    const same = new Date(now.getTime());
    const different = new Date(now.getTime() + 1000);
    expect(deepEqual(now, same)).toBe(true);
    expect(deepEqual(now, different)).toBe(false);
  });

  it('should compare Uint8Arrays correctly', () => {
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('should compare RegExps correctly', () => {
    expect(deepEqual(/abc/g, /abc/g)).toBe(true);
    expect(deepEqual(/abc/g, /abc/i)).toBe(false);
    expect(deepEqual(/abc/g, /def/g)).toBe(false);
  });

  it('should compare Objects correctly', () => {
    expect(deepEqual({}, {})).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false); // Same value, different key
  });

  it('should handle nested structures', () => {
    const obj1 = { a: [1, { b: new Date(1000) }] };
    const obj2 = { a: [1, { b: new Date(1000) }] };
    const obj3 = { a: [1, { b: new Date(2000) }] };

    expect(deepEqual(obj1, obj2)).toBe(true);
    expect(deepEqual(obj1, obj3)).toBe(false);
  });
});

describe('makeLiveQueryKey', () => {
  it('should produce a stable string from primitives', () => {
    expect(makeLiveQueryKey('files', 1, true)).toBe('["files",1,true]');
  });

  it('should produce the same key for identical args across calls', () => {
    const a = makeLiveQueryKey('q', [1, 2], { page: 3 });
    const b = makeLiveQueryKey('q', [1, 2], { page: 3 });
    expect(a).toBe(b);
  });

  it('should produce different keys for different args', () => {
    const a = makeLiveQueryKey('q', 1);
    const b = makeLiveQueryKey('q', 2);
    expect(a).not.toBe(b);
  });

  it('should handle null and undefined', () => {
    const a = makeLiveQueryKey(null, undefined);
    const b = makeLiveQueryKey(null, undefined);
    expect(a).toBe(b);
    // null and undefined both serialize to null in JSON
    expect(a).toBe('[null,null]');
  });

  it('should handle empty args', () => {
    expect(makeLiveQueryKey()).toBe('[]');
  });
});

describe('usePGliteLiveQuery cacheKey', () => {
  let mockSubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSubscribe = vi.fn();
    mockUnsubscribe = vi.fn();
    mockQuery = vi.fn().mockReturnValue({
      initialResults: { rows: [] },
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      refresh: vi.fn(),
    });

    (usePGliteDatabase as any).mockReturnValue({
      raw: {
        live: {
          query: mockQuery,
          incrementalQuery: mockQuery,
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function CacheKeyComponent({ cacheKey, params }: { cacheKey?: string; params?: unknown[] }) {
    usePGliteLiveQuery({
      cacheKey,
      query: 'SELECT * FROM test WHERE id = $1',
      params,
    });
    return null;
  }

  it('should not resubscribe when cacheKey stays the same despite new params reference', () => {
    const key = makeLiveQueryKey('test', 1);
    const { rerender } = render(<CacheKeyComponent cacheKey={key} params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // New params array reference, same cacheKey
    rerender(<CacheKeyComponent cacheKey={key} params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should resubscribe when cacheKey changes', () => {
    const key1 = makeLiveQueryKey('test', 1);
    const key2 = makeLiveQueryKey('test', 2);
    const { rerender } = render(<CacheKeyComponent cacheKey={key1} params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    rerender(<CacheKeyComponent cacheKey={key2} params={[2]} />);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('should pass params to the query even when using cacheKey', () => {
    const key = makeLiveQueryKey('test', 42);
    render(<CacheKeyComponent cacheKey={key} params={[42]} />);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        params: [42],
      })
    );
  });

  it('should fall back to deepEqual behavior when cacheKey is not provided', () => {
    const { rerender } = render(<CacheKeyComponent params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Same content, new reference - should NOT resubscribe (deepEqual catches it)
    rerender(<CacheKeyComponent params={[1]} />);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Different content - should resubscribe
    rerender(<CacheKeyComponent params={[2]} />);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
