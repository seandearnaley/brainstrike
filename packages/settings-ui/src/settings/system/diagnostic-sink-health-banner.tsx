/**
 * Flight Recorder P2b Task 5: the §4.3 honest-degradation surface for a
 * diagnostic sink that gave up after repeated flush failures. Shown at the top of
 * Logging & Diagnostics and of the Logs page, because the Persistent log source
 * and the retention card below it describe a store that is no longer written.
 */
export function DiagnosticSinkHealthBanner({ reason }: { reason: string }) {
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-warning text-xs"
      data-testid="diagnostic-sink-health-banner"
      role="alert"
    >
      <span className="font-medium">Durable diagnostic capture has stopped.</span> Warnings and
      errors are no longer being written to the local database, so the Persistent log view and
      exports will not include anything after this point. Reason: {reason}. Restarting the app
      re-enables capture.
    </div>
  );
}
