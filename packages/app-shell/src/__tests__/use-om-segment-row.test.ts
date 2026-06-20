import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const usePGliteLiveQueryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
  makeLiveQueryKey: (...parts: unknown[]) => parts.map((p) => String(p)).join(':'),
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
      buildObservationalMemoryLookupKey({ scope: 'thread', threadId: 't1', resourceId: 'r1' })
    ).toBe('thread:t1');
  });

  it('resource (Workspace) scope → resource:<resourceId>, NOT thread:<threadId>', () => {
    expect(
      buildObservationalMemoryLookupKey({ scope: 'resource', threadId: 't1', resourceId: 'r1' })
    ).toBe('resource:r1');
  });

  it('returns null when the scope-required id is absent (no query issued)', () => {
    expect(
      buildObservationalMemoryLookupKey({ scope: 'thread', threadId: undefined, resourceId: 'r1' })
    ).toBeNull();
    expect(
      buildObservationalMemoryLookupKey({
        scope: 'resource',
        threadId: 't1',
        resourceId: undefined,
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
      rows: [{ observationTokenCount: 1 }],
      loading: false,
      error: null,
    });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        scope: 'thread',
        threadId: 'thread-abc',
        resourceId: 'res-1',
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
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error: null });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        scope: 'resource',
        threadId: 'thread-abc',
        resourceId: 'res-1',
      })
    );
    const options = captureLastOptions();
    expect(options.enabled).toBe(true);
    expect(options.params).toEqual(['resource:res-1']);
  });

  it('DISABLES the query on web (no durable capability) — never queries PGlite', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error: null });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: false,
        scope: 'thread',
        threadId: 'thread-abc',
        resourceId: 'res-1',
      })
    );
    expect(captureLastOptions().enabled).toBe(false);
  });

  it('DISABLES the query when the scope-required id is absent', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error: null });
    renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        scope: 'thread',
        threadId: undefined,
        resourceId: 'res-1',
      })
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
      useObservationalMemoryRow({
        hasDurableCapability: true,
        scope: 'thread',
        threadId: 'thread-abc',
        resourceId: 'res-1',
      })
    );
    expect(result.current.row).toEqual({ observationTokenCount: 42 });
  });

  it('FIX 4: a disabled query yields NO stale row even if the live layer still holds prior rows', () => {
    // Simulate usePGliteLiveQuery keeping the prior thread's rows when disabled
    // (clearOnDisable is async); the hook must still return null when disabled.
    usePGliteLiveQueryMock.mockReturnValue({
      rows: [{ observationTokenCount: 7777 }],
      loading: false,
      error: null,
    });
    const { result } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        scope: 'thread',
        threadId: undefined, // no active thread → disabled
        resourceId: 'res-1',
      })
    );
    expect(result.current.row).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('only reports loading while the query is enabled', () => {
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: true, error: null });
    const { result: disabled } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: false,
        scope: 'thread',
        threadId: 'thread-abc',
        resourceId: 'res-1',
      })
    );
    // Disabled → loading must be false (no real fetch in flight).
    expect(disabled.current.loading).toBe(false);

    const { result: enabled } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        scope: 'thread',
        threadId: 'thread-abc',
        resourceId: 'res-1',
      })
    );
    expect(enabled.current.loading).toBe(true);
  });

  it('surfaces the live-query error (never swallowed)', () => {
    const error = new Error('live query failed');
    usePGliteLiveQueryMock.mockReturnValue({ rows: [], loading: false, error });
    const { result } = renderHook(() =>
      useObservationalMemoryRow({
        hasDurableCapability: true,
        scope: 'thread',
        threadId: 'thread-abc',
        resourceId: 'res-1',
      })
    );
    expect(result.current.error).toBe(error);
  });
});
