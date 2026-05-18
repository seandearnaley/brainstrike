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

/**
 * Tree-sitter-supported languages. Phase 1 of the tree-sitter rollout
 * (PRD #998) ships Python only; follow-on PRDs add Rust/Go/Markdown/etc.
 * The chunking-worker treats this list as the operator-controlled
 * opt-in for tree-sitter routing per language.
 */
export type TreeSitterLanguage = 'python';

declare global {
  // biome-ignore lint/style/useNamingConvention: shared global keyed by intentionally-unique screaming-snake name
  var __BRAINSTRIKE_PARSER_ENV__: ParserEnvironment | undefined;
  // biome-ignore lint/style/useNamingConvention: shared global keyed by intentionally-unique screaming-snake name
  var __BRAINSTRIKE_PARSER_FLAG__: ParserFlag | undefined;
  // biome-ignore lint/style/useNamingConvention: shared global keyed by intentionally-unique screaming-snake name
  var __BRAINSTRIKE_TREE_SITTER_LANGUAGES__: readonly string[] | undefined;
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

/**
 * Recognized tree-sitter languages this build understands. Mirrors the
 * `TreeSitterLanguage` union; kept as a runtime array because the
 * globalThis-injected list comes from arbitrary `?treeSitterLanguages=`
 * URL params or test setup and needs validation, not just type narrowing.
 */
const RECOGNIZED_TREE_SITTER_LANGUAGES: readonly TreeSitterLanguage[] = ['python'];

/**
 * Returns the tree-sitter languages the operator has opted in to.
 *
 * Production: set by the renderer's bootstrap (Phase 8 of #998) based on
 * the `?treeSitterLanguages=python,rust,...` URL param. The bootstrap
 * helper validates entries before assigning to globalThis; this function
 * is the second-line validator in case the global was set directly
 * (tests, future code paths).
 *
 * Strict mode (Phase 9 hardening, per user directive
 * feedback_no_silent_fallbacks):
 *  - undefined → []         (valid pre-bootstrap state)
 *  - empty array → []       (explicit kill switch)
 *  - non-array → THROW      (shape error — bootstrap is buggy)
 *  - unknown entry → THROW  (deployment error — typo or unshipped lang)
 *  - non-string entry → THROW
 *
 * The previous (Phase 5) coerce-silently-to-[] behavior was a footgun:
 * an operator typo would default-disable tree-sitter without any signal.
 * Failing here surfaces the misconfiguration.
 */
export function getEnabledTreeSitterLanguages(): readonly TreeSitterLanguage[] {
  const raw = globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      `__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ must be an array, got ${typeof raw}. ` +
        'The renderer bootstrap is buggy — fix it before deploying.'
    );
  }
  const result: TreeSitterLanguage[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error(
        `__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ must contain only strings, got ${typeof entry}.`
      );
    }
    if (!(RECOGNIZED_TREE_SITTER_LANGUAGES as readonly string[]).includes(entry)) {
      throw new Error(
        `Unknown tree-sitter language: ${entry}. ` +
          `Recognized: ${RECOGNIZED_TREE_SITTER_LANGUAGES.join(', ')}. ` +
          'A typo or unshipped language was specified.'
      );
    }
    result.push(entry as TreeSitterLanguage);
  }
  return result;
}
