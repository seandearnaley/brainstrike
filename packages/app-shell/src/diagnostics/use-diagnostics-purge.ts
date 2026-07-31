import { DiagnosticEventsRepository } from '@brainstrike/db';
import { useOptionalPGliteDatabase } from '@brainstrike/db/react';
import {
  diagnosticsRetentionSelectors,
  useDiagnosticsRetentionStore,
} from '@brainstrike/preferences/stores/diagnostics-retention-store';
import { useCallback } from 'react';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Renderer-side hook (Flight Recorder P2b Task 4) that builds the "Purge
 * now" callback for the Diagnostics Retention settings card from the live
 * PGlite handle and the user's configured retention preferences (Task 1's
 * `diagnostics-retention-store`). Shared between web and desktop — same
 * reason `useDurableLogSource` is shared rather than duplicated per app.
 *
 * Capability by composition, mirroring `useDurableLogSource`:
 * `useOptionalPGliteDatabase()` returns `null` until a db handle is ready,
 * in which case this hook returns `undefined` and callers should render no
 * purge control rather than a disabled/no-op one.
 */
export function useDiagnosticsPurge(): (() => Promise<number>) | undefined {
  const db = useOptionalPGliteDatabase();
  const maxAgeDays = useDiagnosticsRetentionStore(diagnosticsRetentionSelectors.maxAgeDays);
  const maxRows = useDiagnosticsRetentionStore(diagnosticsRetentionSelectors.maxRows);

  const purge = useCallback(async () => {
    if (!db) {
      // Unreachable via the exposed API (the hook only returns this closure
      // when `db` is truthy below), kept as a loud guard rather than a
      // silent no-op in case a caller ever holds onto a stale reference.
      throw new Error('Diagnostics database is not available.');
    }
    return new DiagnosticEventsRepository(db).purge({
      maxAgeMs: maxAgeDays * MS_PER_DAY,
      maxRows,
    });
  }, [db, maxAgeDays, maxRows]);

  return db ? purge : undefined;
}
