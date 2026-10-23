/**
 * Tree-sitter language opt-in for runtime-less parser routing.
 *
 * `selectAdapter()` routes `.py`/`.pyi` files to tree-sitter only when
 * `getEnabledTreeSitterLanguages()` includes the language. The list is read
 * from a globalThis-injected value that tests set directly. Canonical
 * chunkers pass a strict runtime that always parses Python and never read it.
 */

/**
 * Tree-sitter-supported languages. Phase 1 of the tree-sitter rollout
 * (PRD #998) ships Python only; follow-on PRDs add Rust/Go/Markdown/etc.
 * The chunking-worker treats this list as the operator-controlled
 * opt-in for tree-sitter routing per language.
 */
export type TreeSitterLanguage = 'python';

declare global {
  var __BRAINSTRIKE_TREE_SITTER_LANGUAGES__: readonly string[] | undefined;
}

/**
 * Recognized tree-sitter languages this build understands. Mirrors the
 * `TreeSitterLanguage` union; kept as a runtime array because the
 * globalThis-injected list is untyped and needs validation, not just type
 * narrowing. Adding a language means updating this constant + the
 * `TreeSitterLanguage` union + landing the grammar.
 */
const RECOGNIZED_TREE_SITTER_LANGUAGES: readonly TreeSitterLanguage[] = ['python'];

/**
 * Returns the tree-sitter languages opted in through
 * `globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__`.
 *
 * Strict mode (Phase 9 hardening, per user directive
 * feedback_no_silent_fallbacks):
 *  - undefined → []         (not opted in)
 *  - empty array → []       (explicit kill switch)
 *  - non-array → THROW      (shape error)
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
    throw new Error(`__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ must be an array, got ${typeof raw}.`);
  }
  const result: TreeSitterLanguage[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== 'string') {
      throw new Error(
        '__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ must contain only strings, ' +
          `got ${typeof entry} at index ${i}.`
      );
    }
    if (!(RECOGNIZED_TREE_SITTER_LANGUAGES as readonly string[]).includes(entry)) {
      throw new Error(
        `Unknown tree-sitter language: ${entry} (index ${i}). ` +
          `Recognized: ${RECOGNIZED_TREE_SITTER_LANGUAGES.join(', ')}. ` +
          'A typo or unshipped language was specified.'
      );
    }
    result.push(entry as TreeSitterLanguage);
  }
  return result;
}
