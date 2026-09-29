import type { DatabaseInitPhaseReport } from '@brainstrike/types';

/**
 * Per-phase deadlines for the DB host's `init` request (BST-1883). The host reports each long
 * synchronous phase BEFORE it starts (`DatabaseInitPhaseReport`), and the manager arms that
 * phase's budget from the O(1) size in the report. Pure and Electron-free.
 *
 * These are measured policy, not tuning knobs. The measurements (Apple M1 Pro, Electron 44.4.5,
 * PGlite 0.5.8, pg_textsearch 1.3.1) live in `docs/agents/database/pg-textsearch-qualification.md`.
 * Re-measure and re-pin `db-host-init-budget.test.ts`; never raise a constant to absorb a slow
 * phase. A kill mid-rebuild leaves no clean-shutdown marker, so the next open rebuilds again from
 * scratch: an unscaled deadline loops.
 */

/**
 * `init` sent to the first phase report: process boot and module load. Today's whole-init value,
 * not re-measured.
 */
export const DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS = 90_000;

/** Added to every size-derived budget: fixed costs and scheduling noise. */
export const DB_HOST_INIT_PHASE_FLOOR_MS = 30_000;

/**
 * `pg_wal` bytes per millisecond the open budget assumes: 4 MiB/s, 8.75x under the slowest
 * measured WAL redo rate (35 MB/s, in system Node, slower than Electron). `pg_wal` bytes on disk
 * bound the redo length from above, so the budget can only err large.
 */
export const DB_HOST_WAL_REDO_BUDGET_BYTES_PER_MS = (4 * 1024 * 1024) / 1000;

/**
 * 136 migrations took 0.84 s measured, and none rewrites a large table. This is today's whole-init
 * value. A migration that rewrites a large table must report its own phase (or be split) before it
 * ships; it may not raise this.
 */
export const DB_HOST_INIT_MIGRATION_BUDGET_MS = 90_000;

/**
 * `heap + toast` bytes per millisecond the rebuild budget assumes: 1 MiB/s, 7x under the slowest
 * measured rate (7.1 MB/s). Heap plus TOAST is the best O(1) predictor of a BM25 REINDEX (the rate
 * of `content` bytes spans only 1.3x, but measuring those is an O(n) scan); index bytes and row
 * counts vary 4x and 13x and are not used.
 */
export const DB_HOST_REINDEX_BUDGET_BYTES_PER_MS = (1024 * 1024) / 1000;

/**
 * The longest delay Node's `setTimeout` honours (2^31 - 1 ms, 24.8 days). A longer one is clamped
 * to 1 ms and fires at once, so a budget past it is refused, never armed.
 */
export const DB_HOST_INIT_MAX_BUDGET_MS = 2_147_483_647;

function assertByteCount(bytes: number, what: string): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError(`${what} must be a finite non-negative byte count; received ${bytes}.`);
  }
}

function budgetFromBytes(bytes: number, bytesPerMs: number, what: string): number {
  const budgetMs = DB_HOST_INIT_PHASE_FLOOR_MS + Math.ceil(bytes / bytesPerMs);
  if (budgetMs > DB_HOST_INIT_MAX_BUDGET_MS) {
    throw new RangeError(
      `${what} of ${bytes} bytes needs a ${budgetMs} ms budget, past the longest timer (${DB_HOST_INIT_MAX_BUDGET_MS} ms).`
    );
  }
  return budgetMs;
}

/**
 * The deadline for the phase a report announces: how long the host may stay silent before main
 * treats it as wedged. Throws for a report whose bytes cannot yield an armable deadline.
 */
export function resolveInitPhaseBudgetMs(report: DatabaseInitPhaseReport): number {
  switch (report.phase) {
    case 'open-database':
      assertByteCount(report.pgWalBytes, 'pgWalBytes');
      return budgetFromBytes(report.pgWalBytes, DB_HOST_WAL_REDO_BUDGET_BYTES_PER_MS, 'pgWalBytes');
    case 'index-rebuild': {
      const { heapBytes, toastBytes } = report.index;
      assertByteCount(heapBytes, 'heapBytes');
      assertByteCount(toastBytes, 'toastBytes');
      return budgetFromBytes(
        heapBytes + toastBytes,
        DB_HOST_REINDEX_BUDGET_BYTES_PER_MS,
        'heapBytes + toastBytes'
      );
    }
    case 'migration':
      return DB_HOST_INIT_MIGRATION_BUDGET_MS;
  }
}
