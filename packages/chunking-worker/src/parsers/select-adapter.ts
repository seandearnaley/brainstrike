/**
 * Parser adapter selection facade.
 *
 * Returns the right `ParserAdapter` for the current execution context.
 * `portable-chunking.ts` calls this in the chunking hot path — it never
 * imports a specific adapter directly. That isolation is what lets the
 * routing matrix grow without touching the consumer.
 *
 * Routing matrix (Phase 5):
 *   environment == 'browser'              → babel  (no Electron IPC available)
 *   environment == 'electron-chunking-host' AND flag == 'babel'    → babel  (kill switch)
 *   environment == 'electron-chunking-host' AND flag == 'oxc'      → oxc + babel fallback
 *   environment == 'electron-chunking-host' AND flag == 'auto'     → oxc + babel fallback
 *
 * Per-file fallback to babel is wired in via `withFallback` so a single oxc
 * failure never breaks the pipeline. Telemetry counts the events; sustained
 * fallback rate is the health signal Phase 8 monitors.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4, §9
 */

import { babelAdapter } from './babel-adapter';
import { getEnvironment, getParserFlag } from './environment';
import { withFallback } from './fallback-adapter';
import { oxcIpcAdapter } from './oxc-ipc-adapter';
import type { ParserAdapter } from './types';

// Lazy-cache the wrapped oxc adapter so we don't re-wrap on every selectAdapter
// call. The wrapper itself is stateless, so caching is safe.
let cachedOxcWithFallback: ParserAdapter | null = null;
function oxcWithFallback(): ParserAdapter {
  if (!cachedOxcWithFallback) {
    cachedOxcWithFallback = withFallback(oxcIpcAdapter, babelAdapter);
  }
  return cachedOxcWithFallback;
}

/**
 * Pick the parser adapter for the current call site.
 *
 * Synchronous by design: called on every parse, must not block. Reads
 * environment + flag from globalThis (set by the chunking-host bootstrap
 * in production; set directly by tests).
 *
 * Constraints encoded:
 *   - Must be synchronous (chunking hot path)
 *   - Must never throw — falling back to Babel is always valid
 *   - Should be cheap (called per-file, not per-batch)
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

  // 'oxc' or 'auto' both pick the wrapped oxc adapter (with per-file Babel fallback).
  return oxcWithFallback();
}

/**
 * @internal — clears the wrapped-adapter cache so tests that swap globals
 * see fresh routing decisions without holding onto a stale wrapper.
 */
export function __resetSelectAdapterCacheForTesting(): void {
  cachedOxcWithFallback = null;
}
