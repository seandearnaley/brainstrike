/**
 * How long closing the DB host may wait at each rung of the close ladder
 * (`DbHostManager.close()`): close acknowledgement, then exit after SIGTERM,
 * then exit after SIGKILL. Nothing here is raised to absorb a slow close; a
 * host that misses a rung is escalated, never waited on longer.
 */
export const DB_HOST_CLOSE_ACK_TIMEOUT_MS = 2000;
export const DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS = 1000;
export const DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS = 500;

/** The longest a full close can take: every rung used in turn. */
export const DB_HOST_CLOSE_BUDGET_MS =
  DB_HOST_CLOSE_ACK_TIMEOUT_MS +
  DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS +
  DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS;
