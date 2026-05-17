/**
 * Parser adapter selection facade.
 *
 * Returns the right `ParserAdapter` for the current execution context.
 * `portable-chunking.ts` calls this in the chunking hot path — it never
 * imports a specific adapter directly. That isolation is what lets the
 * routing matrix grow without touching the consumer.
 *
 * Routing matrix:
 *   environment == 'browser'                                      → babel
 *   environment == 'electron-chunking-host' AND flag == 'babel'   → babel  (kill switch)
 *   environment == 'electron-chunking-host' AND flag == 'oxc'     → oxc
 *   environment == 'electron-chunking-host' AND flag == 'auto'    → oxc
 *
 * **No per-file Babel fallback** (decision: 2026-05-16). The earlier
 * `withFallback` wrapper silently routed failing oxc parses to Babel and
 * counted them via telemetry. Project owner direction: that hides bugs
 * exactly when they matter most — a single misbehaving codepath would
 * generate thousands of fallback events and the perf win would silently
 * evaporate without anyone noticing. Now: if oxc breaks, the parser
 * throws and the call site's existing strategy fallback (non-AST
 * recursive chunking) takes over, logged at warn level so it's visible.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4, §9
 */

import { babelAdapter } from './babel-adapter';
import { getEnvironment, getParserFlag } from './environment';
import { oxcIpcAdapter } from './oxc-ipc-adapter';
import type { ParserAdapter } from './types';

/**
 * Pick the parser adapter for the current call site.
 *
 * Synchronous by design: called on every parse, must not block. Reads
 * environment + flag from globalThis (set by the chunking-host bootstrap
 * in production; set directly by tests).
 *
 * Constraints encoded:
 *   - Must be synchronous (chunking hot path)
 *   - Selecting is safe; the *returned adapter's* parse() may throw on
 *     failure — by design, so the caller can decide whether to escalate
 *     or degrade gracefully (`portable-chunking.ts`'s catch falls
 *     through to non-AST recursive splitting with a warn log).
 *   - Should be cheap (called per-file, not per-batch).
 */
export function selectAdapter(): ParserAdapter {
  const env = getEnvironment();

  // Browser cannot reach the parser host's Electron IPC channel — always Babel.
  if (env === 'browser') {
    return babelAdapter;
  }

  // Electron chunking-host. Flag controls oxc vs Babel.
  const flag = getParserFlag();
  if (flag === 'babel') {
    return babelAdapter;
  }

  // 'oxc' or 'auto' → native oxc via IPC. No fallback wrapper: if oxc
  // fails, the failure surfaces loudly to the caller's catch block.
  return oxcIpcAdapter;
}
