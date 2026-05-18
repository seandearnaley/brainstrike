/**
 * Strict-mode contract tests for getEnabledTreeSitterLanguages.
 *
 * Phase 9 hardening (#998 follow-on): per the strictness directive
 * (memory: feedback_no_silent_fallbacks), malformed values for
 * `globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__` must throw on first
 * access — not silently coerce to `[]`.
 *
 * Silent coercion was the original (Phase 5) behavior; this test locks
 * the new fail-fast contract. The valid paths (undefined → default,
 * explicit array of recognized languages) still work without throwing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnabledTreeSitterLanguages } from '../parsers/environment';

function reset(): void {
  globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = undefined;
}

describe('getEnabledTreeSitterLanguages (Phase 9 strict)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('returns [] when global is undefined (default-off baseline)', () => {
    // Undefined isn't malformed — it's "renderer didn't set anything"
    // which is a valid state pre-bootstrap. Empty array is the right
    // answer here, not an error.
    expect(getEnabledTreeSitterLanguages()).toEqual([]);
  });

  it('returns the list when global is a valid array of recognized languages', () => {
    globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = ['python'];
    expect(getEnabledTreeSitterLanguages()).toEqual(['python']);
  });

  it('THROWS when global is set to a non-array value', () => {
    // Strict: non-array means somebody assigned the wrong shape. We
    // can't recover; surfacing the type error at first access is the
    // honest answer.
    // @ts-expect-error — testing invalid shape
    globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = 'python';

    expect(() => getEnabledTreeSitterLanguages()).toThrow(/must be an array/i);
  });

  it('THROWS when global is set to an object', () => {
    // @ts-expect-error — testing invalid shape
    globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = { python: true };

    expect(() => getEnabledTreeSitterLanguages()).toThrow();
  });

  it('THROWS when array contains unrecognized language names', () => {
    // Strict: typo'd entries are deployment errors. The rollout helper
    // is supposed to throw earlier (at URL parse), but this is the
    // second-line check in case the global was set directly.
    globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = ['python', 'pithon'];

    expect(() => getEnabledTreeSitterLanguages()).toThrow(/unknown tree-sitter language: pithon/i);
  });

  it('THROWS when array contains non-string entries', () => {
    // @ts-expect-error — testing invalid shape
    globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ = ['python', 42];

    expect(() => getEnabledTreeSitterLanguages()).toThrow();
  });
});
