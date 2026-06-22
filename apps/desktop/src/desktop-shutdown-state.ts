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

// The ONLY teardown signature treated as benign regardless of shutdown state:
// pino's thread-stream "the worker is ending", emitted when the logger transport
// is disposed. That is a logging-infra artifact, never an embedding-worker
// failure, so it is safe to silence anytime. Broad embedding-worker signatures
// ("worker terminated/stopped") are deliberately NOT matched here — outside
// shutdown they can be a REAL mid-session worker crash (e.g. "Embedding worker
// terminated during an active stream"), which must surface as a failure instead
// of being silenced. During shutdown those broad stops are still benign, but
// that is covered by isDesktopShuttingDown() in isExpectedBackfillTeardown below.
// Lives here (no heavy deps) so every consumer can import it.
const BENIGN_BACKFILL_SHUTDOWN_PATTERN = /worker is ending/i;

export function isBenignBackfillShutdownError(error: unknown): boolean {
  return error instanceof Error && BENIGN_BACKFILL_SHUTDOWN_PATTERN.test(error.message);
}

// An embedding backfill error is an EXPECTED teardown — log quietly, no UI
// failure — when EITHER the app is shutting down (any error from a backfill torn
// down mid-flight during graceful quit is benign) OR the error is the logger
// thread-stream teardown above. A broad "worker terminated" OUTSIDE shutdown is
// NOT expected: it is a real failure that must surface (embed jobs stay durable
// in job_queue, but the user must still see that the backfill failed).
export function isExpectedBackfillTeardown(error: unknown): boolean {
  return isDesktopShuttingDown() || isBenignBackfillShutdownError(error);
}
