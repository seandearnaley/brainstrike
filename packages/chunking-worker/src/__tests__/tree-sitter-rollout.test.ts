/**
 * Tree-sitter rollout bootstrap helper tests (Phase 8 of #998).
 *
 * Phase 8 flips the rollout switch: tree-sitter Python is enabled by
 * default in app renderers, with a URL-param kill switch for in-field
 * revert. This helper centralizes the URL parsing so both apps/web and
 * apps/desktop share one tested implementation.
 *
 * The contract:
 *   no `treeSitterLanguages` param        → ['python']  (default-on)
 *   `?treeSitterLanguages=`               → []          (explicit kill switch)
 *   `?treeSitterLanguages=python,rust`    → ['python']  (filter to recognized;
 *                                                        rust drops silently
 *                                                        until its grammar ships)
 *   malformed (extra spaces, etc.)        → trimmed + filtered
 *
 * Note the kill-switch semantics: an empty `?treeSitterLanguages=` is an
 * INTENT to disable, not a typo. We respect it. A typo like
 * `?treeSitterLanguages=pithon` produces [] after filtering — also a safe
 * default (the operator wanted something custom; we don't run the rollout
 * default in case they intended to enable just 'rust' but mistyped).
 *
 * See: docs/prd-chunking-tree-sitter-2026-05.md §8, §9.1
 */

import { describe, expect, it } from 'vitest';
import { resolveBootstrapTreeSitterLanguages } from '../parsers/tree-sitter-rollout';

describe('resolveBootstrapTreeSitterLanguages', () => {
  it("defaults to ['python'] when the URL has no treeSitterLanguages param", () => {
    expect(resolveBootstrapTreeSitterLanguages('')).toEqual(['python']);
    expect(resolveBootstrapTreeSitterLanguages('?mode=chunking-host')).toEqual(['python']);
    expect(resolveBootstrapTreeSitterLanguages('?parserFlag=babel')).toEqual(['python']);
  });

  it('returns [] when treeSitterLanguages is explicitly empty (kill switch)', () => {
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=')).toEqual([]);
  });

  it('returns the explicit list when present', () => {
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python')).toEqual(['python']);
  });

  it('THROWS on unrecognized languages — operator typos must surface, not silently drop (Phase 9 strict)', () => {
    // Per the strictness directive (memory: feedback_no_silent_fallbacks):
    // a typo'd language name like 'rust' (grammar not yet shipped) or
    // 'pithon' (typo) is a deployment error. Silently filtering would
    // hide it; throwing surfaces it at boot.
    expect(() => resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python,rust')).toThrow(
      /unknown tree-sitter language: rust/i
    );
    expect(() => resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=pithon')).toThrow(
      /unknown tree-sitter language: pithon/i
    );
  });

  it('SKIPS empty entries — trailing commas and whitespace are URL artifacts not operator intent (#1007 review)', () => {
    // Trailing commas are common when URLs are constructed by joining
    // arrays (`langs.join(',')` over `['python']` gives `'python'` but
    // `langs.map(...).join(',')` can leave separators). Don't crash boot
    // on URL serialization quirks. Only unknown NON-EMPTY entries throw.
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python,')).toEqual(['python']);
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=,python,')).toEqual([
      'python',
    ]);
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python, ,python')).toEqual([
      'python',
      'python',
    ]);
  });

  it('preserves the order from the URL', () => {
    // When future languages ship, order will matter for routing precedence.
    // For now there's only python, but the helper shouldn't sort or
    // dedupe — that's the caller's concern.
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python')).toEqual(['python']);
  });

  it('allows duplicates in the URL (caller dedupes if needed)', () => {
    // `?treeSitterLanguages=python,python` is unambiguous — the operator
    // listed it twice. Not a typo; not an error. Preserve as-is.
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python,python')).toEqual([
      'python',
      'python',
    ]);
  });
});
