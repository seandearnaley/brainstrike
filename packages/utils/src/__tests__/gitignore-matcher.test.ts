/**
 * BST-1427: gitignore semantics for the workspace walk.
 *
 * These cases pin the two things a WALK needs that a naive matcher gets wrong:
 * directory pruning (which requires the trailing-slash form) and nested
 * `.gitignore` scoping (a file's patterns apply to its own subtree, relative to
 * its own directory).
 *
 * They are deliberately explicit about `ignore`'s behaviour rather than
 * deferring to it, because gitignore reimplementations disagree on edge cases
 * (the `ignore` package vs Python `pathspec` vs git itself). Pinning the
 * behaviour we depend on means an upgrade that changes it fails here.
 */
import { describe, expect, it } from 'vitest';
import { createGitignoreMatcher } from '../gitignore-matcher.js';

describe('createGitignoreMatcher', () => {
  it('prunes a directory whose pattern is directory-only', () => {
    // THE case the walk depends on. `ignore` returns false for `ignores('dist')`
    // when the pattern is `dist/` — the trailing slash makes it directory-only,
    // and a bare path carries no directory signal. A walk that asked the bare
    // form would descend into the directory and reject its files one at a time,
    // which is exactly the cap-starvation this change exists to prevent.
    const matcher = createGitignoreMatcher();
    matcher.push('', 'dist/\nnode_modules/\n');
    expect(matcher.ignoresDirectory('dist')).toBe(true);
    expect(matcher.ignoresDirectory('node_modules')).toBe(true);
    expect(matcher.ignoresDirectory('src')).toBe(false);
  });

  it('ignores files under a directory-only pattern', () => {
    const matcher = createGitignoreMatcher();
    matcher.push('', 'dist/\n');
    expect(matcher.ignoresFile('dist/bundle.js')).toBe(true);
    expect(matcher.ignoresFile('src/main.ts')).toBe(false);
  });

  it('honours a nested .gitignore only within its own subtree', () => {
    const matcher = createGitignoreMatcher();
    matcher.push('', '');
    matcher.push('packages/web', 'generated/\n');
    expect(matcher.ignoresDirectory('packages/web/generated')).toBe(true);
    // The same name elsewhere is NOT covered by that nested file.
    expect(matcher.ignoresDirectory('packages/api/generated')).toBe(false);
  });

  it('pops a nested scope back off when the walk leaves the directory', () => {
    const matcher = createGitignoreMatcher();
    matcher.push('', '');
    matcher.push('packages/web', 'generated/\n');
    expect(matcher.ignoresDirectory('packages/web/generated')).toBe(true);
    matcher.pop();
    expect(matcher.ignoresDirectory('packages/web/generated')).toBe(false);
  });

  it('applies root-anchored patterns only at the scope that declared them', () => {
    const matcher = createGitignoreMatcher();
    matcher.push('', '/build\n');
    expect(matcher.ignoresDirectory('build')).toBe(true);
    expect(matcher.ignoresDirectory('packages/web/build')).toBe(false);
  });

  it('honours negation, including re-including inside an ignored parent name', () => {
    const matcher = createGitignoreMatcher();
    matcher.push('', '*.log\n!keep.log\n');
    expect(matcher.ignoresFile('a.log')).toBe(true);
    expect(matcher.ignoresFile('keep.log')).toBe(false);
  });

  it('treats an absent or empty .gitignore as ignoring nothing', () => {
    const matcher = createGitignoreMatcher();
    matcher.push('', '');
    matcher.push('packages/web', '   \n# just a comment\n');
    expect(matcher.ignoresDirectory('packages/web/anything')).toBe(false);
    expect(matcher.ignoresFile('packages/web/a.ts')).toBe(false);
  });

  it('ignores nothing when no scope has been pushed', () => {
    // A root with no `.gitignore` at all must not accidentally ignore anything;
    // the static policy floor carries those roots on its own.
    const matcher = createGitignoreMatcher();
    expect(matcher.ignoresDirectory('node_modules')).toBe(false);
    expect(matcher.ignoresFile('a.ts')).toBe(false);
  });

  it('lets a deeper .gitignore re-include what an outer one ignored', () => {
    // git resolves the LAST matching pattern, and a nested file is more
    // specific than its parent, so this ordering is load-bearing.
    const matcher = createGitignoreMatcher();
    matcher.push('', '*.generated.ts\n');
    matcher.push('packages/web', '!keep.generated.ts\n');
    expect(matcher.ignoresFile('packages/web/keep.generated.ts')).toBe(false);
    expect(matcher.ignoresFile('packages/web/other.generated.ts')).toBe(true);
  });

  it('returns a verdict for a directory literally named "..." rather than throwing', () => {
    // Review of #2598 raised this as an unhandled-throw risk, on the theory that
    // `ignore`'s non-relative-path guard would fire for `...`. Probed against the
    // pinned version: it does not — `...`, `.../` and `.../child` all return
    // ordinary verdicts. What DOES throw is a path starting `./`, `../` or `/`,
    // and `readdir` cannot produce any of those, so the walk never reaches it.
    //
    // Deliberately NOT "fixed" with `allowRelativePaths: true`. That flag makes a
    // genuinely malformed path return "not ignored" instead of erroring, turning
    // a loud bug into a silent one: a caller passing an absolute path would
    // quietly get every exclusion skipped. The right fix is normalising at the
    // boundary that produces the path. Pinned here because `ignore` edge-case
    // behaviour is what this spec exists to assert rather than assume.
    const matcher = createGitignoreMatcher();
    matcher.push('', 'dist/\n');
    expect(matcher.ignoresDirectory('...')).toBe(false);
    expect(matcher.ignoresFile('.../child.ts')).toBe(false);
  });
});
