/**
 * Process-wide "is the desktop app shutting down" flag.
 *
 * Background work that is torn down mid-flight during graceful shutdown (e.g.
 * an in-flight embedding backfill whose embedding host / DB host is disposed)
 * rejects with teardown errors that are EXPECTED, not failures. Consumers read
 * this flag to log such errors at info instead of error and to skip alarming
 * "failed" diagnostics. The work itself is durable (job_queue rows persist;
 * a suspended dimension index is reconciled by scheduled maintenance), so the
 * interruption loses no progress.
 */
let shuttingDown = false;

/** Marked once at the start of graceful shutdown; never reset (the process exits). */
export function markDesktopShuttingDown(): void {
  shuttingDown = true;
}

export function isDesktopShuttingDown(): boolean {
  return shuttingDown;
}

// Teardown signatures from a host/worker being disposed mid-backfill (notably
// pino's thread-stream "the worker is ending" when the logger transport is torn
// down at shutdown). These are EXPECTED stops, not failures, even outside the
// app-quit path (e.g. an embedding host restart). Lives here (no heavy deps) so
// every consumer can import it without pulling in the backfill module.
const BENIGN_BACKFILL_SHUTDOWN_PATTERN = /worker is ending|worker (?:has )?(?:stopped|terminated)/i;

export function isBenignBackfillShutdownError(error: unknown): boolean {
  return error instanceof Error && BENIGN_BACKFILL_SHUTDOWN_PATTERN.test(error.message);
}
