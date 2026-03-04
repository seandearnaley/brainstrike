import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepEqual, usePGliteLiveQuery } from '../src/use-live-query.js';

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
