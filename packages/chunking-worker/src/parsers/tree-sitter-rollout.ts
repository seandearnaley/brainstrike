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

/** Languages enabled by default when no URL param is present (Phase 8). */
const DEFAULT_ENABLED_LANGUAGES: readonly string[] = ['python'];

/** Languages whose grammars are vendored and known to load. */
const RECOGNIZED_LANGUAGES: readonly string[] = ['python'];

/**
 * Compute the tree-sitter language list to install on globalThis for the
 * worker to pick up.
 *
 * @param search - the URL's search string (e.g., `?treeSitterLanguages=python`).
 *                 Accept the raw string rather than pre-parsed
 *                 URLSearchParams so this function is callable from any
 *                 context (including server-side or test environments).
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

  // Explicit list — split on comma, trim, drop empties, filter to
  // shipped grammars. An operator typo that filters to [] yields []
  // (not the default), because the presence of the param means the
  // operator wanted SOMETHING non-default; running the default in
  // that case would be confusing.
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => RECOGNIZED_LANGUAGES.includes(s));
}
