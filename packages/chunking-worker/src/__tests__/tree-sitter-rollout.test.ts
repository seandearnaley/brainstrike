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

  it('filters out unrecognized languages silently', () => {
    // 'rust' is in the operator's intent but not yet shipped — drop it.
    // Real protection: shipping 'rust' here without the grammar would
    // crash at parse time (Language.load fails). Filter early.
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python,rust')).toEqual([
      'python',
    ]);
  });

  it('returns [] when the list contains only unrecognized languages', () => {
    // Typo case: operator wanted to enable something, we don't recognize
    // it. The safest interpretation is "don't fall back to default" —
    // because the operator clearly intended SOMETHING non-default.
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=pithon')).toEqual([]);
  });

  it('trims whitespace and ignores empty entries in comma lists', () => {
    expect(resolveBootstrapTreeSitterLanguages('?treeSitterLanguages=python, , python')).toEqual([
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
});
