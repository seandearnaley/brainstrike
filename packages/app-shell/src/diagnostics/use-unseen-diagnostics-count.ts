import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { useDiagnosticsSeenStore } from './diagnostics-seen-store';
import {
  retainedCountsCapability,
  useNativeUnseenDiagnosticsCount,
} from './use-native-unseen-diagnostics-count';

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
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    parsed = Number(value);
  } else {
    return null;
  }
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function useUnseenDiagnosticsCount(): UnseenDiagnosticsCountResult {
  const native = retainedCountsCapability();
  const database = usePGliteDatabase({ enabled: !native });
  const lastSeenAtMs = useDiagnosticsSeenStore((state) => state.lastSeenAtMs);
  const nativeCounts = useNativeUnseenDiagnosticsCount(native, lastSeenAtMs);
  // Repo convention: bind timestamptz params as ISO strings, not epoch ms —
  // `mapDiagnosticEventRow` converts the column back the same way.
  const lastSeenAtIso = useMemo(() => new Date(lastSeenAtMs).toISOString(), [lastSeenAtMs]);
  const params = useMemo(() => [lastSeenAtIso] as const, [lastSeenAtIso]);
  const queryEnabled = database !== null;

  const { error, loading, rows } = usePGliteLiveQuery<UnseenDiagnosticsCountRow>({
    cacheKey: makeLiveQueryKey('diagnostics-unseen', lastSeenAtIso),
    enabled: queryEnabled,
    params,
    query: UNSEEN_DIAGNOSTICS_QUERY,
  });

  const counts = useMemo(() => {
    const row = rows[0];
    if (!queryEnabled || loading || row === undefined) {
      return { aggregateError: null, errorCount: 0, warningCount: 0 };
    }
    const errorCount = parseAggregateCount(row.errorCount);
    const warningCount = parseAggregateCount(row.warningCount);
    if (errorCount === null || warningCount === null) {
      return {
        aggregateError: new Error('Unseen diagnostics query returned invalid aggregate counts'),
        errorCount: 0,
        warningCount: 0,
      };
    }
    return { aggregateError: null, errorCount, warningCount };
  }, [loading, queryEnabled, rows]);

  if (native) {
    return nativeCounts;
  }
  return {
    error: error ?? counts.aggregateError,
    errorCount: counts.errorCount,
    warningCount: counts.warningCount,
  };
}
