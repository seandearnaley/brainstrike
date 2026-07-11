import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/utils/logger';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useHookTrustScope } from '../use-hook-trust-scope';

interface ResolveEntry {
  dbRootId: string;
  path: string;
}
type Resolver = (paths: readonly string[]) => Promise<readonly ResolveEntry[]>;
type Descriptors = Readonly<Record<string, { path?: string | null }>>;

// Stable descriptor references (in production these come from a zustand
// selector, so their identity only changes when the roots actually change; a
// fresh object literal per render would defeat the effect's dependency check).
const ROOTS_A: Descriptors = { a: { path: '/a' } };
const ROOTS_B: Descriptors = { b: { path: '/b' } };

function setResolver(resolver: Resolver | undefined): void {
  Object.defineProperty(window, 'hooks', {
    configurable: true,
    value: resolver ? { resolveTrustedRootIds: resolver } : {},
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'hooks');
  vi.useRealTimers();
});

describe('useHookTrustScope', () => {
  test('returns null when disabled (attest nothing)', () => {
    setResolver(async () => []);
    const { result } = renderHook(() =>
      useHookTrustScope({ enabled: false, rootDescriptors: ROOTS_A })
    );
    expect(result.current).toBeNull();
  });

  test('resolves the mounted DB root ids for the current descriptors', async () => {
    setResolver(async () => [{ dbRootId: 'db-a', path: '/a' }]);
    const { result } = renderHook(() =>
      useHookTrustScope({ enabled: true, rootDescriptors: ROOTS_A })
    );
    await waitFor(() => {
      expect(result.current).not.toBeNull();
      expect([...(result.current ?? [])]).toEqual(['db-a']);
    });
  });

  // FINDING 1: a root-descriptor change must fail closed IMMEDIATELY. While the
  // new resolution is pending (never settles), the scope must be EMPTY — the
  // previous resolved scope must not linger and re-attest a disconnected root.
  test('clears the scope synchronously on a descriptor change while resolution is pending', async () => {
    let resolveFirst: ((entries: readonly ResolveEntry[]) => void) | undefined;
    const first = new Promise<readonly ResolveEntry[]>((res) => {
      resolveFirst = res;
    });
    // Second resolution never settles → simulates the in-flight window.
    const pendingForever = new Promise<readonly ResolveEntry[]>(() => {
      /* never resolves */
    });
    let call = 0;
    setResolver(() => {
      call += 1;
      return call === 1 ? first : pendingForever;
    });

    const { result, rerender } = renderHook(
      (props: { descriptors: Descriptors }) =>
        useHookTrustScope({ enabled: true, rootDescriptors: props.descriptors }),
      { initialProps: { descriptors: ROOTS_A } }
    );

    await act(async () => {
      resolveFirst?.([{ dbRootId: 'db-a', path: '/a' }]);
      await first;
    });
    expect([...(result.current ?? [])]).toEqual(['db-a']);

    // Descriptor identity changes; the new resolution is pending forever.
    act(() => {
      rerender({ descriptors: ROOTS_B });
    });

    // The scope must NOT still be ['db-a'] — it fails closed to empty at once.
    expect(result.current).not.toBeNull();
    expect([...(result.current ?? [])]).toEqual([]);
  });

  // FINDING 3: a transient resolver rejection warns and retries ONCE (bounded).
  test('warns and retries once after a resolver rejection', async () => {
    setLogLevel(LogLevel.WARN);
    vi.useFakeTimers();
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'HookTrustScope') {
        captured.push(record);
      }
    });
    try {
      let call = 0;
      setResolver(() => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error('db not ready'))
          : Promise.resolve([{ dbRootId: 'db-a', path: '/a' }]);
      });

      renderHook(() => useHookTrustScope({ enabled: true, rootDescriptors: ROOTS_A }));

      // Let the rejected first attempt settle.
      await vi.advanceTimersByTimeAsync(0);
      expect(
        captured.some((r) => r.level === LogLevel.WARN && String(r.message).includes('trusted'))
      ).toBe(true);
      expect(call).toBe(1);

      // Advance past the retry delay → exactly one retry fires.
      await vi.advanceTimersByTimeAsync(600);
      expect(call).toBe(2);
    } finally {
      removeListener();
    }
  });
});
