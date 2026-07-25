import type { DiagnosticEventsDatabase } from '@brainstrike/db';
import { __resetDiagnosticsRetentionStoreForTests } from '@brainstrike/preferences/stores/diagnostics-retention-store';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useOptionalPGliteDatabaseMock } = vi.hoisted(() => ({
  useOptionalPGliteDatabaseMock: vi.fn(),
}));

// Override only `useOptionalPGliteDatabase`; keep every other real export
// (mirrors the established pattern in `use-durable-log-source.test.tsx`).
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: useOptionalPGliteDatabaseMock,
}));

import { useDiagnosticsRetentionStore } from '@brainstrike/preferences/stores/diagnostics-retention-store';
import { useDiagnosticsPurge } from '../diagnostics/use-diagnostics-purge';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function makeRecordingDb(): {
  calls: { sql: string; params?: unknown[] | undefined }[];
  db: DiagnosticEventsDatabase;
} {
  const calls: { sql: string; params?: unknown[] | undefined }[] = [];
  return {
    calls,
    db: {
      query: <T,>(sql: string, params?: unknown[]) => {
        calls.push({ params, sql });
        return Promise.resolve({ rows: [] as T[] });
      },
    },
  };
}

describe('useDiagnosticsPurge', () => {
  beforeEach(() => {
    useOptionalPGliteDatabaseMock.mockReset();
    __resetDiagnosticsRetentionStoreForTests();
  });

  it('returns undefined without a db handle', () => {
    useOptionalPGliteDatabaseMock.mockReturnValue(null);

    const { result } = renderHook(() => useDiagnosticsPurge());

    expect(result.current).toBeUndefined();
  });

  it('returns a callable purge function once a db handle is present', () => {
    const { db } = makeRecordingDb();
    useOptionalPGliteDatabaseMock.mockReturnValue(db);

    const { result } = renderHook(() => useDiagnosticsPurge());

    expect(typeof result.current).toBe('function');
  });

  it('purges using the store defaults (30 days / 20,000 rows) when unconfigured', async () => {
    const { calls, db } = makeRecordingDb();
    useOptionalPGliteDatabaseMock.mockReturnValue(db);

    const { result } = renderHook(() => useDiagnosticsPurge());
    await result.current?.();

    const overCapDelete = calls.find((entry) => entry.sql.includes('OFFSET $1'));
    expect(overCapDelete?.params).toEqual([20_000]);

    const agedDelete = calls.find(
      (entry) => entry.sql.includes('DELETE') && entry.sql.includes('occurred_at <')
    );
    const cutoffIso = agedDelete?.params?.[0] as string;
    const cutoffMs = new Date(cutoffIso).getTime();
    const expectedCutoffMs = Date.now() - 30 * MS_PER_DAY;
    // Bounded tolerance for wall-clock drift between the assertion and the
    // call inside the hook, not an exact-timestamp comparison.
    expect(Math.abs(cutoffMs - expectedCutoffMs)).toBeLessThan(5000);
  });

  it('purges using the CONFIGURED retention values once the store is edited', async () => {
    const { calls, db } = makeRecordingDb();
    useOptionalPGliteDatabaseMock.mockReturnValue(db);
    useDiagnosticsRetentionStore.getState().setMaxAgeDays(7);
    useDiagnosticsRetentionStore.getState().setMaxRows(5000);

    const { result } = renderHook(() => useDiagnosticsPurge());
    await result.current?.();

    const overCapDelete = calls.find((entry) => entry.sql.includes('OFFSET $1'));
    expect(overCapDelete?.params).toEqual([5000]);

    const agedDelete = calls.find(
      (entry) => entry.sql.includes('DELETE') && entry.sql.includes('occurred_at <')
    );
    const cutoffIso = agedDelete?.params?.[0] as string;
    const cutoffMs = new Date(cutoffIso).getTime();
    const expectedCutoffMs = Date.now() - 7 * MS_PER_DAY;
    expect(Math.abs(cutoffMs - expectedCutoffMs)).toBeLessThan(5000);
  });
});
