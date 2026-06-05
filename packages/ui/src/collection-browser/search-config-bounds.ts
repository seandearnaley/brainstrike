/**
 * Result-limit bounds for semantic/hybrid search.
 *
 * Single source of truth shared by the UI input clamp (`SearchConfigPanel`) and
 * the executor's defense-in-depth clamp (`use-semantic-search-executor`). The
 * ceiling bounds hybrid RRF fan-out — each source pool is sized to the limit, so
 * the worst case fuses ~2× this many candidates — and that cost guard must be
 * enforced where the fan-out actually happens, not only in the UI input.
 */

/** Smallest selectable result limit. */
export const RESULT_LIMIT_MIN = 1;
/** Largest result limit; bounds hybrid source-pool fan-out and renderer cost. */
export const RESULT_LIMIT_MAX = 2000;
/** Past this, the UI warns that large rank passes are slower (informed choice). */
export const RESULT_LIMIT_LARGE = 1000;

/**
 * Clamp a (possibly persisted or programmatic) result limit into
 * `[RESULT_LIMIT_MIN, RESULT_LIMIT_MAX]`. Non-finite input floors to the minimum
 * rather than propagating `NaN` into a query `limit`.
 */
export function clampResultLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return RESULT_LIMIT_MIN;
  }
  return Math.min(RESULT_LIMIT_MAX, Math.max(RESULT_LIMIT_MIN, Math.trunc(limit)));
}
