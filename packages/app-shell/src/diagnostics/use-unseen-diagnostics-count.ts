import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db';
import { useMemo } from 'react';
import { useDiagnosticsSeenStore } from './diagnostics-seen-store';

/**
 * Reactive count of diagnostic events recorded since the session watermark
 * (`useDiagnosticsSeenStore.lastSeenAtMs`), backing the status-bar chip
 * (Flight Recorder P2b Task 3, design §9).
 *
 * `brainstrike_diagnostic_events` has a CHECK constraint restricting
 * `severity` to `warn`/`error`/`fatal` (migration 073) — every row in the
 * table already qualifies as "warn+", so no severity predicate belongs in
 * this query. Do NOT add one "for clarity" or "to be safe": it would be
 * redundant today and would silently diverge if the constraint's allowed
 * list ever changes (the constraint, not a duplicated filter, is the single
 * source of truth for what counts).
 *
 * `usePGliteDatabase()` is called directly rather than gating this hook
 * behind `useOptionalPGliteDatabase()` + a child-component split: it never
 * throws for a missing/not-yet-ready handle — it returns `null` (only
 * `useVectorEnabled`-style helpers that assert a provider throw). This
 * mirrors `useDailySpend` (`cost-tracking/use-daily-spend.ts`), the existing
 * precedent in this same package for gating a live query on the raw handle.
 */
const UNSEEN_DIAGNOSTICS_QUERY =
  'SELECT COUNT(*)::int AS count FROM brainstrike_diagnostic_events WHERE occurred_at > $1';

interface UnseenDiagnosticsCountRow {
  readonly count: number | string | null;
}

export interface UnseenDiagnosticsCountResult {
  readonly count: number;
  readonly error: Error | null;
}

export function useUnseenDiagnosticsCount(): UnseenDiagnosticsCountResult {
  const database = usePGliteDatabase();
  const lastSeenAtMs = useDiagnosticsSeenStore((state) => state.lastSeenAtMs);
  // Repo convention: bind timestamptz params as ISO strings, not epoch ms —
  // `mapDiagnosticEventRow` converts the column back the same way.
  const lastSeenAtIso = useMemo(() => new Date(lastSeenAtMs).toISOString(), [lastSeenAtMs]);
  const params = useMemo(() => [lastSeenAtIso] as const, [lastSeenAtIso]);

  const { error, rows } = usePGliteLiveQuery<UnseenDiagnosticsCountRow>({
    cacheKey: makeLiveQueryKey('diagnostics-unseen', lastSeenAtIso),
    enabled: database !== null,
    params,
    query: UNSEEN_DIAGNOSTICS_QUERY,
  });

  const count = useMemo(() => Number(rows[0]?.count ?? 0), [rows]);

  return { count, error };
}
