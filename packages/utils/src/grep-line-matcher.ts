import { assertSafeRegexSource } from './filter-utils.js';

/**
 * Per-line match predicate. Shared between the indexed grep path (this service)
 * and the desktop live (ripgrep/JS-walk) pass so both produce IDENTICAL matches
 * for the same pattern — there is exactly one definition of "does this line
 * match", never a forked weaker copy.
 */
export interface LineMatcher {
  matches: (line: string) => boolean;
}

function buildLiteralMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return {
    matches: (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle),
  };
}

function buildRegexMatcher(pattern: string, caseSensitive: boolean): LineMatcher {
  // ReDoS guard BEFORE compiling: this matcher runs the caller/model-supplied
  // regex per-line across up to maxLiveCandidateFiles whole files, so a
  // catastrophic-backtracking pattern would freeze the host. Reuse the shared
  // length + dangerous-shape guard (throws with a clear message; no silent
  // fallback). Covers both the indexed path and the desktop live-grep pass,
  // which share this matcher.
  assertSafeRegexSource(pattern);
  let regex: RegExp;
  try {
    // Never include 'g': the same regex instance is called per-line, and
    // the 'g' flag makes test() stateful (lastIndex), breaking per-line matching.
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression pattern: ${message}`);
  }
  return { matches: (line) => regex.test(line) };
}

/**
 * Build the authoritative per-line matcher for a grep pattern. Literal patterns
 * use a (case-folded) substring test; regex patterns compile to a real JS
 * `RegExp` (an invalid pattern throws `Invalid regular expression pattern: …`).
 *
 * Exported so non-DB callers (the desktop live grep pass) match lines with the
 * exact same semantics as the indexed path.
 */
export function createGrepLineMatcher(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): LineMatcher {
  return isRegex
    ? buildRegexMatcher(pattern, caseSensitive)
    : buildLiteralMatcher(pattern, caseSensitive);
}
