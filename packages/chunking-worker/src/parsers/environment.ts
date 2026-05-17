/**
 * Environment + feature-flag detection for parser adapter routing.
 *
 * Two pieces of state determine which adapter `selectAdapter()` returns:
 *   1. Where is the chunking worker running? — `getEnvironment()`
 *   2. What does the user/operator want? — `getParserFlag()`
 *
 * Both are read from globalThis-injected values rather than environment
 * detection heuristics. The chunking-host's bootstrap (Phase 8) sets the
 * globals; tests set them directly. Heuristic detection (e.g., probing for
 * `electron.ipcRenderer`) was rejected because it would force every call
 * site to await a probe — defeating the point of a sync facade.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §9
 */

export type ParserEnvironment = 'browser' | 'electron-chunking-host';
export type ParserFlag = 'auto' | 'babel' | 'oxc';

declare global {
  // biome-ignore lint/style/useNamingConvention: shared global keyed by intentionally-unique screaming-snake name
  var __BRAINSTRIKE_PARSER_ENV__: ParserEnvironment | undefined;
  // biome-ignore lint/style/useNamingConvention: shared global keyed by intentionally-unique screaming-snake name
  var __BRAINSTRIKE_PARSER_FLAG__: ParserFlag | undefined;
}

/**
 * Returns the current parser-routing environment.
 *
 * Production: set by the chunking-host renderer's bootstrap before importing
 * the chunking-worker. Defaults to 'browser' for `apps/web` and any other
 * context that hasn't opted in.
 */
export function getEnvironment(): ParserEnvironment {
  const value = globalThis.__BRAINSTRIKE_PARSER_ENV__;
  return value === 'electron-chunking-host' ? 'electron-chunking-host' : 'browser';
}

/**
 * Returns the currently-configured parser flag.
 *
 * Recognized values: 'auto' (let selectAdapter pick per environment),
 * 'babel' (kill switch — Babel everywhere), 'oxc' (force oxc, meaningful
 * only in Electron).
 *
 * **Unset → 'auto'** (default behavior).
 * **Set but unrecognized → 'babel'** (rollout-safety nit #991): if an
 * operator types `?parserFlag=foo`, they clearly intended *something
 * non-default*. The safest interpretation of "non-default but unknown"
 * for a kill-switch is to stay on the known-good path. The previous
 * "coerce unknown to auto" behavior would route to oxc in Electron
 * on a typo — exactly the case where defensiveness matters most.
 */
export function getParserFlag(): ParserFlag {
  const value = globalThis.__BRAINSTRIKE_PARSER_FLAG__;
  if (value === 'auto' || value === 'babel' || value === 'oxc') {
    return value;
  }
  return value === undefined ? 'auto' : 'babel';
}
