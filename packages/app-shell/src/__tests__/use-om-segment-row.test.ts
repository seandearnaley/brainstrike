import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...parts: unknown[]) => parts.map((p) => String(p)).join(':'),
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));

import {
  buildObservationalMemoryLookupKey,
  useObservationalMemoryRow,
} from '../use-om-segment-row';

interface CapturedOptions {
  clearOnDisable?: boolean;
  enabled?: boolean;
  params?: readonly unknown[];
  query: string;
}

function captureLastOptions(): CapturedOptions {
  const lastCall = usePGliteLiveQueryMock.mock.calls.at(-1);
  return lastCall?.[0] as CapturedOptions;
}

describe('buildObservationalMemoryLookupKey', () => {
  it('thread scope → thread:<threadId> (mirrors observationalMemoryKey / getStorageIds)', () => {
    expect(
      buildObservationalMemoryLookupKey({ resourceId: 'r1', scope: 'thread', threadId: 't1' })
    ).toBe('thread:t1');
  });

  it('resource (Workspace) scope → resource:<resourceId>, NOT thread:<threadId>', () => {
    expect(
      buildObservationalMemoryLookupKey({ resourceId: 'r1', scope: 'resource', threadId: 't1' })
    ).toBe('resource:r1');
  });

  it('returns null when the scope-required id is absent (no query issued)', () => {
    expect(
      buildObservationalMemoryLookupKey({ resourceId: 'r1', scope: 'thread', threadId: undefined })
    ).toBeNull();
    expect(
      buildObservationalMemoryLookupKey({
        resourceId: undefined,
        scope: 'resource',
        threadId: 't1',
      })
    ).toBeNull();
  });
});

describe('useObservationalMemoryRow', () => {
  afterEach(() => {
    usePGliteLiveQueryMock.mockReset();
  });

  it('enables + keys by thread:<id> for thread scope, with clearOnDisable', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ observationTokenCount: 1 }],
    });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: 'thread-abc',
      })
    );
    const options = captureLastOptions();
    expect(options.enabled).toBe(true);
    expect(options.params).toEqual(['thread:thread-abc']);
    expect(options.clearOnDisable).toBe(true);
    // The query must select the LATEST generation (mirrors the memory store read order).
    expect(options.query).toMatch(/generationCount.*DESC/is);
    expect(options.query).toMatch(/LIMIT\s+1/i);
  });

  it('FIX 3: Workspace (resource) scope queries resource:<resourceId>, not the thread key', () => {
    usePGliteLiveQueryMock.mockReturnValue({ error: null, loading: false, rows: [] });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        resourceId: 'res-1',
        scope: 'resource',
        threadId: 'thread-abc',
      })
    );
    const options = captureLastOptions();
    expect(options.enabled).toBe(true);
    expect(options.params).toEqual(['resource:res-1']);
  });

  it('DISABLES the query on web (no durable capability) — never queries PGlite', () => {
    usePGliteLiveQueryMock.mockReturnValue({ error: null, loading: false, rows: [] });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: false,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: 'thread-abc',
      })
    );
    expect(captureLastOptions().enabled).toBe(false);
  });

  it('DISABLES the query when the scope-required id is absent', () => {
    usePGliteLiveQueryMock.mockReturnValue({ error: null, loading: false, rows: [] });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: undefined,
      })
    );
    expect(captureLastOptions().enabled).toBe(false);
  });

  it('returns the first (latest-generation) row, or null when none', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ observationTokenCount: 42 }],
    });
    const { result } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: 'thread-abc',
      })
    );
    expect(result.current.row).toEqual({ observationTokenCount: 42 });
  });

  it('FIX 4: a disabled query yields NO stale row even if the live layer still holds prior rows', () => {
    // Simulate usePGliteLiveQuery keeping the prior thread's rows when disabled
    // (clearOnDisable is async); the hook must still return null when disabled.
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      rows: [{ observationTokenCount: 7777 }],
    });
    const { result } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: undefined, // no active thread → disabled
      })
    );
    expect(result.current.row).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('only reports loading while the query is enabled', () => {
    usePGliteLiveQueryMock.mockReturnValue({ error: null, loading: true, rows: [] });
    const { result: disabled } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: false,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: 'thread-abc',
      })
    );
    // Disabled → loading must be false (no real fetch in flight).
    expect(disabled.current.loading).toBe(false);

    const { result: enabled } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: 'thread-abc',
      })
    );
    expect(enabled.current.loading).toBe(true);
  });

  it('surfaces the live-query error (never swallowed)', () => {
    const error = new Error('live query failed');
    usePGliteLiveQueryMock.mockReturnValue({ error, loading: false, rows: [] });
    const { result } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        resourceId: 'res-1',
        scope: 'thread',
        threadId: 'thread-abc',
      })
    );
    expect(result.current.error).toBe(error);
  });
});
