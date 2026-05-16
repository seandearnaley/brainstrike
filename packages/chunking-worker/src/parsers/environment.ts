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
  // biome-ignore lint: global declarations require var
  var __BRAINSTRIKE_PARSER_ENV__: ParserEnvironment | undefined;
  // biome-ignore lint: global declarations require var
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
 * Defaults to 'auto', which means selectAdapter picks the best adapter for
 * the environment (oxc in Electron, Babel in browser). Explicit 'babel'
 * forces Babel everywhere — kill-switch for the rollout. Explicit 'oxc'
 * forces oxc but is only meaningful in Electron contexts.
 */
export function getParserFlag(): ParserFlag {
  const value = globalThis.__BRAINSTRIKE_PARSER_FLAG__;
  return value === 'babel' || value === 'oxc' ? value : 'auto';
}
