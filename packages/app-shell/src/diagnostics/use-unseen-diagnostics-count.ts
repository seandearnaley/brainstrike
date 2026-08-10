import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { useDiagnosticsSeenStore } from './diagnostics-seen-store';

/**
 * Reactive count of diagnostic events recorded since the session watermark
 * (`useDiagnosticsSeenStore.lastSeenAtMs`), backing the status-bar chip
 * (Flight Recorder P2b Task 3, design §9).
 *
 * `brainstrike_diagnostic_events` has a CHECK constraint restricting
 * `severity` to `warn`/`error`/`fatal` (migration 073), so every row already
 * qualifies as "warn+". The FILTER clauses do not decide eligibility; they
 * partition that constrained set so the status chip never labels warnings as
 * errors. Fatal rows intentionally share the error bucket.
 *
 * `usePGliteDatabase()` is called directly rather than gating this hook
 * behind `useOptionalPGliteDatabase()` + a child-component split: it never
 * throws for a missing/not-yet-ready handle — it returns `null` (only
 * `useVectorEnabled`-style helpers that assert a provider throw). This
 * mirrors `useDailySpend` (`cost-tracking/use-daily-spend.ts`), the existing
 * precedent in this same package for gating a live query on the raw handle.
 */
export const UNSEEN_DIAGNOSTICS_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE severity IN ('error', 'fatal'))::int AS "errorCount",
    COUNT(*) FILTER (WHERE severity = 'warn')::int AS "warningCount"
  FROM brainstrike_diagnostic_events
  WHERE occurred_at > $1
`;

interface UnseenDiagnosticsCountRow {
  readonly errorCount: number | string | null;
  readonly warningCount: number | string | null;
}

export interface UnseenDiagnosticsCountResult {
  readonly error: Error | null;
  readonly errorCount: number;
  readonly warningCount: number;
}

function parseAggregateCount(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function useUnseenDiagnosticsCount(): UnseenDiagnosticsCountResult {
  const database = usePGliteDatabase();
  const lastSeenAtMs = useDiagnosticsSeenStore((state) => state.lastSeenAtMs);
  // Repo convention: bind timestamptz params as ISO strings, not epoch ms —
  // `mapDiagnosticEventRow` converts the column back the same way.
  const lastSeenAtIso = useMemo(() => new Date(lastSeenAtMs).toISOString(), [lastSeenAtMs]);
  const params = useMemo(() => [lastSeenAtIso] as const, [lastSeenAtIso]);

  const { error, loading, rows } = usePGliteLiveQuery<UnseenDiagnosticsCountRow>({
    cacheKey: makeLiveQueryKey('diagnostics-unseen', lastSeenAtIso),
    enabled: database !== null,
    params,
    query: UNSEEN_DIAGNOSTICS_QUERY,
  });

  const counts = useMemo(() => {
    if (loading) {
      return { aggregateError: null, errorCount: 0, warningCount: 0 };
    }
    const row = rows[0];
    const errorCount = parseAggregateCount(row?.errorCount);
    const warningCount = parseAggregateCount(row?.warningCount);
    if (errorCount === null || warningCount === null) {
      return {
        aggregateError: new Error('Unseen diagnostics query returned invalid aggregate counts'),
        errorCount: 0,
        warningCount: 0,
      };
    }
    return { aggregateError: null, errorCount, warningCount };
  }, [loading, rows]);

  return {
    error: error ?? counts.aggregateError,
    errorCount: counts.errorCount,
    warningCount: counts.warningCount,
  };
}
