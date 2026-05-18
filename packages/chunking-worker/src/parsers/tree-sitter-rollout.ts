/**
 * Tree-sitter rollout bootstrap helper.
 *
 * Phase 8 of #998 flips the rollout switch — tree-sitter Python parsing
 * becomes enabled by default in app renderers. This helper centralizes
 * the URL-param parsing so apps/web and apps/desktop share one tested
 * implementation, and so the rollout default + kill-switch contract live
 * in one place.
 *
 * Apps call this at boot (before any chunking-worker import) and assign
 * the result to `globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__`:
 *
 *   globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ =
 *     resolveBootstrapTreeSitterLanguages(window.location.search);
 *
 * The defensive coercion in `getEnabledTreeSitterLanguages` (in
 * environment.ts) is the second-line filter — this helper's job is
 * applying the rollout DEFAULT, not validating language names.
 *
 * See: docs/prd-chunking-tree-sitter-2026-05.md §8, §9.1
 */

import { RECOGNIZED_TREE_SITTER_LANGUAGES } from './environment';

/** Languages enabled by default when no URL param is present (Phase 8). */
const DEFAULT_ENABLED_LANGUAGES: readonly string[] = ['python'];

// `RECOGNIZED_TREE_SITTER_LANGUAGES` lives in environment.ts (single
// source of truth). Importing it here prevents the drift hazard called
// out in #1007 review where two parallel `['python']` arrays would need
// to be updated together every time a grammar lands.

/**
 * Compute the tree-sitter language list to install on globalThis for the
 * worker to pick up.
 *
 * Strict mode (Phase 9 of #998 hardening, per user directive
 * feedback_no_silent_fallbacks): unknown or malformed entries THROW
 * rather than silently coerce. A typo'd flag is a deployment error,
 * not "operator probably meant something" — surface it at boot so the
 * operator fixes it before traffic.
 *
 * @param search - the URL's search string (e.g., `?treeSitterLanguages=python`).
 *                 Accept the raw string rather than pre-parsed
 *                 URLSearchParams so this function is callable from any
 *                 context (including server-side or test environments).
 * @throws when the `treeSitterLanguages` param contains unknown language
 *         names or malformed entries (empty items inside a list).
 */
export function resolveBootstrapTreeSitterLanguages(search: string): readonly string[] {
  const params = new URLSearchParams(search);
  const raw = params.get('treeSitterLanguages');

  if (raw === null) {
    // No param at all — apply the rollout default.
    return [...DEFAULT_ENABLED_LANGUAGES];
  }

  if (raw === '') {
    // Explicit empty string is the kill switch. Respect it.
    return [];
  }

  // Explicit list — split, parse, validate.
  //
  // P1 fix (#1007 review, multiple reviewers): empty entries are URL
  // serialization artifacts, not operator intent. A trailing comma
  // `?treeSitterLanguages=python,` is the common case — operators
  // construct URLs by joining arrays and the resulting trailing
  // separator should not crash the boot. Skip empties silently.
  // Unknown NON-EMPTY entries are still operator-provided values we
  // can't make sense of — those throw (strict directive preserved).
  const entries = raw.split(',');
  const result: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue; // URL artifact, not operator intent
    }
    if (!(RECOGNIZED_TREE_SITTER_LANGUAGES as readonly string[]).includes(trimmed)) {
      throw new Error(
        `Unknown tree-sitter language: ${trimmed}. ` +
          `Recognized languages: ${RECOGNIZED_TREE_SITTER_LANGUAGES.join(', ')}. ` +
          'A typo or unshipped language was specified — fix the URL param.'
      );
    }
    result.push(trimmed);
  }
  return result;
}
