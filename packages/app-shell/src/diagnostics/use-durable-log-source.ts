import { useOptionalPGliteDatabase } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { createDurableLogSource, type DurableLogSource } from './durable-log-source';

/**
 * Renderer-side hook (Flight Recorder P2a) that exposes the durable
 * `brainstrike_diagnostic_events` table as a `DurableLogSource` (a
 * `LogSourceAdapter` widened with `exportNdjson()`, Task 6) for the Logs
 * tab's "Persistent errors" source.
 *
 * Capability by composition, not `isElectron()`: `useOptionalPGliteDatabase()`
 * returns `null` until a PGlite database handle is ready, in which case this
 * hook returns `undefined` and callers should render no persistent-source
 * control. Diagnostics are written on both web and desktop, so the gate is
 * "is there a db handle", never a platform check.
 *
 * The returned adapter is memoized and keyed on the `db` handle's identity
 * so it stays referentially STABLE across re-renders with the same handle.
 * `createDurableLogSource` itself returns a brand-new object on every call
 * (Task 4's contract), and the Log Viewer's effect depends on
 * `logSource` identity to decide whether to tear down and re-subscribe — an
 * unstable adapter would re-subscribe (and restart polling) on every
 * render, the same hazard the desktop `forwardedRecords` prop hit in P1.
 */
export function useDurableLogSource(): DurableLogSource | undefined {
  const db = useOptionalPGliteDatabase();
  return useMemo(() => (db ? createDurableLogSource({ db }) : undefined), [db]);
}
