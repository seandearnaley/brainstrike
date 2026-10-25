/**
 * Process-wide "is this desktop process shutting down" flag, in a module with no imports so
 * the agent host's entry can mark it from its first signal handler.
 *
 * Background work that is torn down mid-flight during graceful shutdown (e.g.
 * native indexing whose embedding host is disposed) rejects with teardown errors
 * that are EXPECTED, not failures. Consumers read this flag to log such errors
 * at info instead of error and to skip alarming "failed" diagnostics.
 */
let shuttingDown = false;

/** Marked once at the start of graceful shutdown; never reset (the process exits). */
export function markDesktopShuttingDown(): void {
  shuttingDown = true;
}

export function isDesktopShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only: the production flag is never reset because the process exits. */
export function resetDesktopShuttingDownForTests(): void {
  shuttingDown = false;
}
