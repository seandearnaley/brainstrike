import type { DiagnosticEventsDatabase } from '@brainstrike/db';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useOptionalPGliteDatabaseMock } = vi.hoisted(() => ({
  useOptionalPGliteDatabaseMock: vi.fn(),
}));

// Override only `useOptionalPGliteDatabase`; keep every other real export
// (mirrors the established pattern in `diagnostic-sink-bridge.test.tsx`).
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: useOptionalPGliteDatabaseMock,
}));
vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: useOptionalPGliteDatabaseMock,
}));

import { useDurableLogSource } from '../diagnostics/use-durable-log-source';

function makeStubDb(): DiagnosticEventsDatabase {
  return {
    query: <T,>(_sql: string, _params?: unknown[]) => Promise.resolve({ rows: [] as T[] }),
  };
}

describe('useDurableLogSource', () => {
  beforeEach(() => {
    useOptionalPGliteDatabaseMock.mockReset();
  });

  it('returns undefined without a db handle', () => {
    useOptionalPGliteDatabaseMock.mockReturnValue(null);

    const { result } = renderHook(() => useDurableLogSource());

    expect(result.current).toBeUndefined();
  });

  it('returns a stable adapter across re-renders when the db handle identity is stable', () => {
    const db = makeStubDb();
    useOptionalPGliteDatabaseMock.mockReturnValue(db);

    const { result, rerender } = renderHook(() => useDurableLogSource());
    const first = result.current;
    rerender();
    const second = result.current;

    expect(first).toBeDefined();
    expect(typeof first?.getInitialRecords).toBe('function');
    expect(typeof first?.subscribe).toBe('function');
    // Task 4's `createDurableLogSource` returns a NEW object per call; the
    // hook's memoization (keyed on db identity) is what must keep this
    // stable — an unstable identity re-subscribes the Log Viewer's effect
    // on every render (the same hazard `forwardedRecords` hit in P1).
    expect(Object.is(first, second)).toBe(true);
  });

  it('returns a new adapter when the db handle identity changes', () => {
    const dbA = makeStubDb();
    const dbB = makeStubDb();
    useOptionalPGliteDatabaseMock.mockReturnValue(dbA);

    const { result, rerender } = renderHook(() => useDurableLogSource());
    const first = result.current;

    useOptionalPGliteDatabaseMock.mockReturnValue(dbB);
    rerender();
    const second = result.current;

    expect(Object.is(first, second)).toBe(false);
  });
});
