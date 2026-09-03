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
import { createWorkspaceIgnoreMatcher } from '../workspace-ignore-matcher.js';

describe('createWorkspaceIgnoreMatcher', () => {
  it('prunes a directory whose pattern is directory-only', () => {
    // THE case the walk depends on. `ignore` returns false for `ignores('dist')`
    // when the pattern is `dist/` — the trailing slash makes it directory-only,
    // and a bare path carries no directory signal. A walk that asked the bare
    // form would descend into the directory and reject its files one at a time,
    // which is exactly the cap-starvation this change exists to prevent.
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'dist/\nnode_modules/\n' });
    expect(matcher.ignoresDirectory('dist')).toBe(true);
    expect(matcher.ignoresDirectory('node_modules')).toBe(true);
    expect(matcher.ignoresDirectory('src')).toBe(false);
  });

  it('ignores files under a directory-only pattern', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'dist/\n' });
    expect(matcher.ignoresFile('dist/bundle.js')).toBe(true);
    expect(matcher.ignoresFile('src/main.ts')).toBe(false);
  });

  it('honours a nested .gitignore only within its own subtree', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: '' });
    matcher.push('packages/web', { gitignore: 'generated/\n' });
    expect(matcher.ignoresDirectory('packages/web/generated')).toBe(true);
    // The same name elsewhere is NOT covered by that nested file.
    expect(matcher.ignoresDirectory('packages/api/generated')).toBe(false);
  });

  it('pops a nested scope back off when the walk leaves the directory', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: '' });
    matcher.push('packages/web', { gitignore: 'generated/\n' });
    expect(matcher.ignoresDirectory('packages/web/generated')).toBe(true);
    matcher.pop();
    expect(matcher.ignoresDirectory('packages/web/generated')).toBe(false);
  });

  it('applies root-anchored patterns only at the scope that declared them', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: '/build\n' });
    expect(matcher.ignoresDirectory('build')).toBe(true);
    expect(matcher.ignoresDirectory('packages/web/build')).toBe(false);
  });

  it('honours negation, including re-including inside an ignored parent name', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: '*.log\n!keep.log\n' });
    expect(matcher.ignoresFile('a.log')).toBe(true);
    expect(matcher.ignoresFile('keep.log')).toBe(false);
  });

  it('treats an absent or empty .gitignore as ignoring nothing', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: '' });
    matcher.push('packages/web', { gitignore: '   \n# just a comment\n' });
    expect(matcher.ignoresDirectory('packages/web/anything')).toBe(false);
    expect(matcher.ignoresFile('packages/web/a.ts')).toBe(false);
  });

  it('ignores nothing when no scope has been pushed', () => {
    // A root with no `.gitignore` at all must not accidentally ignore anything;
    // the static policy floor carries those roots on its own.
    const matcher = createWorkspaceIgnoreMatcher();
    expect(matcher.ignoresDirectory('node_modules')).toBe(false);
    expect(matcher.ignoresFile('a.ts')).toBe(false);
  });

  it('lets a deeper .gitignore re-include what an outer one ignored', () => {
    // git resolves the LAST matching pattern, and a nested file is more
    // specific than its parent, so this ordering is load-bearing.
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: '*.generated.ts\n' });
    matcher.push('packages/web', { gitignore: '!keep.generated.ts\n' });
    expect(matcher.ignoresFile('packages/web/keep.generated.ts')).toBe(false);
    expect(matcher.ignoresFile('packages/web/other.generated.ts')).toBe(true);
  });

  it('lets an opened-root scope re-include a directory excluded above that root (BST-1434)', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'workspace/cache/\n' }, { pathPrefix: 'workspace' });
    matcher.push('', { gitignore: '!cache/\n' });

    expect(matcher.ignoresDirectory('cache')).toBe(false);
    expect(matcher.ignoresFile('cache/one.md')).toBe(false);
  });

  it('does not let a leaf-only negation bypass an excluded parent directory', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'workspace/cache/\n' }, { pathPrefix: 'workspace' });
    matcher.push('', { gitignore: '!cache/keep.md\n' });

    expect(matcher.ignoresFile('cache/keep.md')).toBe(true);
  });

  it('keeps a descendant-specific exclusion after its parent directory is re-included', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'workspace/cache/**\n' }, { pathPrefix: 'workspace' });
    matcher.push('', { gitignore: '!cache/\n' });

    expect(matcher.ignoresDirectory('cache')).toBe(false);
    expect(matcher.ignoresFile('cache/one.md')).toBe(true);
  });

  it('recovers a descendant exclusion hidden behind a re-included parent', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push(
      '',
      { llmignore: 'workspace/cache/\nworkspace/cache/secret.md\n' },
      { pathPrefix: 'workspace' }
    );
    matcher.push('', { brainstrikeignore: '!cache/\n' });

    expect(matcher.ignoresFile('cache/one.md')).toBe(false);
    expect(matcher.ignoresFile('cache/secret.md')).toBe(true);
  });

  it('keeps every excluded ancestor represented across prefixed parent scopes', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'packages/\n' }, { pathPrefix: 'packages/web' });
    matcher.push('', { gitignore: '!web/\n' }, { pathPrefix: 'web' });
    matcher.push('', {});

    expect(matcher.ignoresFile('index.ts')).toBe(true);
  });

  it('retains repeated unanchored matches below an anchored root re-include', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'cache/\n' }, { pathPrefix: 'workspace' });
    matcher.push('', { gitignore: '!/cache/\n' });

    expect(matcher.ignoresFile('cache/one.md')).toBe(false);
    expect(matcher.ignoresFile('cache/inner/cache/one.md')).toBe(true);
  });

  it('does not change cross-group semantics when an unrelated scope is pushed', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', {
      brainstrikeignore: '!cache/keep.md\n',
      gitignore: 'cache/\n',
    });

    expect(matcher.ignoresFile('cache/keep.md')).toBe(true);

    matcher.push('unrelated', {});

    expect(matcher.ignoresFile('cache/keep.md')).toBe(true);
  });
});

describe('createWorkspaceIgnoreMatcher — source precedence', () => {
  // ONE documented order, lowest priority first:
  //   1 global excludes · 2 .git/info/exclude · 3 parent .gitignore
  //   4 .gitignore · 5 .ignore · 6 .rgignore
  //   7 .llmignore (HARD) · 8 .brainstrikeignore (HARD)
  // Each layer can override the one below it, including with `!`.

  it('lets .ignore hide a file that git tracks', () => {
    // The established "hide from search, keep in git" escape hatch.
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { ignore: 'fixtures/\n' });
    expect(matcher.ignoresDirectory('fixtures')).toBe(true);
  });

  it('lets .ignore re-include what .gitignore excluded', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'build/\n', ignore: '!build/\n' });
    expect(matcher.ignoresDirectory('build')).toBe(false);
  });

  it('lets .rgignore override .ignore', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { ignore: '!build/\n', rgignore: 'build/\n' });
    expect(matcher.ignoresDirectory('build')).toBe(true);
  });

  it('applies global excludes and info/exclude beneath the repo .gitignore', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { globalExcludes: '*.swp\n', infoExclude: 'scratch/\n' });
    expect(matcher.ignoresFile('a.swp')).toBe(true);
    expect(matcher.ignoresDirectory('scratch')).toBe(true);
  });

  it('lets the repo .gitignore re-include what a global exclude hid', () => {
    // Repo-local intent beats machine-wide defaults, which is git's own order.
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: '!keep.swp\n', globalExcludes: '*.swp\n' });
    expect(matcher.ignoresFile('keep.swp')).toBe(false);
    expect(matcher.ignoresFile('other.swp')).toBe(true);
  });
});

describe('createWorkspaceIgnoreMatcher — the agent ignore files are a HARD boundary', () => {
  it('honours .llmignore and .brainstrikeignore', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { brainstrikeignore: 'private/\n', llmignore: 'secrets/\n' });
    expect(matcher.ignoresDirectory('secrets')).toBe(true);
    expect(matcher.ignoresDirectory('private')).toBe(true);
  });

  it("lets brainstrike's own file win over the portable one", () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { brainstrikeignore: '!vendor/\n', llmignore: 'vendor/\n' });
    expect(matcher.ignoresDirectory('vendor')).toBe(false);
  });

  it('STILL excludes under includeIgnored, unlike every other layer', () => {
    // The decision that makes this a security control rather than a preference:
    // a single flag must not defeat "never read, index, or send". Every other
    // layer is bypassable precisely because tools legitimately search excluded
    // trees; this one is not, and that asymmetry is deliberate.
    const matcher = createWorkspaceIgnoreMatcher({ includeIgnored: true });
    matcher.push('', {
      gitignore: 'build/\n',
      ignore: 'fixtures/\n',
      llmignore: 'secrets/\n',
    });
    expect(matcher.ignoresDirectory('build')).toBe(false);
    expect(matcher.ignoresDirectory('fixtures')).toBe(false);
    expect(matcher.ignoresDirectory('secrets')).toBe(true);
    expect(matcher.ignoresFile('secrets/key.pem')).toBe(true);
  });

  it('honours a NESTED agent ignore file within its own subtree', () => {
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', {});
    matcher.push('packages/web', { llmignore: 'private/\n' });
    expect(matcher.ignoresDirectory('packages/web/private')).toBe(true);
    expect(matcher.ignoresDirectory('packages/api/private')).toBe(false);
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
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { gitignore: 'dist/\n' });
    expect(matcher.ignoresDirectory('...')).toBe(false);
    expect(matcher.ignoresFile('.../child.ts')).toBe(false);
  });

  it('does not let a NESTED bypassable layer overturn an outer HARD rule', () => {
    // Review of #2599 (Codex P1). Within layers 1-6 a deeper file legitimately
    // wins — that is ripgrep's model and it is preserved. But the agent layers
    // are sold as unbypassable, and a scope-major fold quietly made them
    // bypassable by anyone who could add a nested `.gitignore`: apply the outer
    // HARD verdict, then the nested BYPASSABLE one, and the negation wins.
    // Hard layers are therefore resolved across ALL scopes, after every
    // bypassable one.
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { llmignore: 'sub/key.ts\n' });
    matcher.push('sub', { gitignore: '!key.ts\n' });
    expect(matcher.ignoresFile('sub/key.ts')).toBe(true);
  });

  it('still lets a deeper HARD file re-include what a shallower HARD file excluded', () => {
    // The nesting rule survives INSIDE the hard group; only the cross-group
    // ordering changed. Otherwise a repo could never carve an exception out of
    // an inherited agent rule.
    const matcher = createWorkspaceIgnoreMatcher();
    matcher.push('', { llmignore: 'sub/key.ts\n' });
    matcher.push('sub', { brainstrikeignore: '!key.ts\n' });
    expect(matcher.ignoresFile('sub/key.ts')).toBe(false);
  });
});
