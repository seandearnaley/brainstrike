/**
 * Parser adapter selection facade.
 *
 * Returns the right `ParserAdapter` for the current execution context.
 * `portable-chunking.ts` calls this in the chunking hot path — it never
 * imports a specific adapter directly. That isolation is what lets later
 * phases swap in additional adapters (oxc-ipc-adapter in Phase 5) without
 * touching the consumer.
 *
 * Selection logic today (Cycle 2.3): always Babel.
 * Selection logic post-Phase-5: routes per environment and feature flag,
 * with per-file fallback to Babel on adapter failures.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4, §9
 */

import type { ParserAdapter } from './types';

/**
 * STUB — Phase 2 Cycle 2.3 RED state.
 *
 * Sentinel adapter with the wrong `id` so the contract test fails honestly
 * at the assertion (not at the import). Replaced wholesale in Cycle 2.3
 * GREEN with a real return of the Babel adapter.
 *
 * TODO(Phase 2 Cycle 2.3 GREEN): replace stub body with `return babelAdapter`.
 */
const stubAdapter: ParserAdapter = {
  id: 'oxc-native',
  async parse() {
    throw new Error('selectAdapter stub — Cycle 2.3 GREEN pending');
  },
};

/**
 * Pick the parser adapter for the current call site.
 *
 * Synchronous by design: called on every parse, must not block. The Phase 5
 * version reads environment + feature flag + adapter health to make the
 * routing decision; today it returns Babel unconditionally.
 */
export function selectAdapter(): ParserAdapter {
  return stubAdapter;
}
