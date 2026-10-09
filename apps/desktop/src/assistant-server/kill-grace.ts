/**
 * Grace period between the polite SIGTERM and the forceful SIGKILL when tearing
 * down a process tree. A well-behaved child exits on SIGTERM; a wedged one is
 * reaped by the follow-up SIGKILL. The command executor and Main's supervisor
 * of a dead host's native process groups (ADR-0017) give the same grace.
 */
export const KILL_GRACE_MS = 2000;
