import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
  makeLiveQueryKey: (...parts: unknown[]) => parts.map((p) => String(p)).join(':'),
}));

import {
  OBSERVATIONAL_MEMORY_LOOKUP_KEY_PREFIX,
  useObservationalMemoryRow,
} from '../use-om-segment-row';

interface CapturedOptions {
  enabled?: boolean;
  params?: readonly unknown[];
  query: string;
}

function captureLastOptions(): CapturedOptions {
  const lastCall = usePGliteLiveQueryMock.mock.calls.at(-1);
  return lastCall?.[0] as CapturedOptions;
}

describe('useObservationalMemoryRow', () => {
  afterEach(() => {
    usePGliteLiveQueryMock.mockReset();
  });

  it('enables the live query and keys by thread:<id> when capable + thread present', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      rows: [{ observationTokenCount: 1 }],
      loading: false,
      error: null,
    });
    renderHook(() =>
      useObservationalMemoryRow({ hasDurableCapability: true, threadId: 'thread-abc' })
    );
    const options = captureLastOptions();
    expect(options.enabled).toBe(true);
    expect(options.params).toEqual([`${OBSERVATIONAL_MEMORY_LOOKUP_KEY_PREFIX}thread-abc`]);
    // The query must select the LATEST generation (mirrors the memory store read order).
    expect(options.query).toMatch(/generationCount.*DESC/is);
    expect(options.query).toMatch(/LIMIT\s+1/i);
  });

  it('DISABLES the query on web (no durable capability) — never queries PGlite', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error: null });
    renderHook(() =>
      useObservationalMemoryRow({ hasDurableCapability: false, threadId: 'thread-abc' })
    );
    expect(captureLastOptions().enabled).toBe(false);
  });

  it('DISABLES the query when there is no active thread', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error: null });
    renderHook(() =>
      useObservationalMemoryRow({ hasDurableCapability: true, threadId: undefined })
    );
    expect(captureLastOptions().enabled).toBe(false);
  });

  it('returns the first (latest-generation) row, or null when none', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      rows: [{ observationTokenCount: 42 }],
      loading: false,
      error: null,
    });
    const { result } = renderHook(() =>
      useObservationalMemoryRow({ hasDurableCapability: true, threadId: 'thread-abc' })
    );
    expect(result.current.row).toEqual({ observationTokenCount: 42 });

    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error: null });
    const { result: emptyResult } = renderHook(() =>
      useObservationalMemoryRow({ hasDurableCapability: true, threadId: 'thread-abc' })
    );
    expect(emptyResult.current.row).toBeNull();
  });

  it('surfaces the live-query error (never swallowed)', () => {
    const error = new Error('live query failed');
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error });
    const { result } = renderHook(() =>
      useObservationalMemoryRow({ hasDurableCapability: true, threadId: 'thread-abc' })
    );
    expect(result.current.error).toBe(error);
  });
});
