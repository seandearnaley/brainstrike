/**
 * Gitignore semantics for a directory walk (BST-1427).
 *
 * A hand-maintained denylist of directory names cannot keep up with the caches
 * a real machine accumulates, and when it falls behind the failure is SILENT: a
 * glob returns `0 matches` rather than an error. Every directory that has hurt
 * us — `.pnpm-store` (82k files), `.turbo`, `.claude/worktrees` — was already
 * gitignored. Respecting `.gitignore` is what ripgrep, fd, VS Code, ESLint and
 * Prettier all do, and it covers the caches nobody enumerated.
 *
 * Implementation is the `ignore` package: the de-facto Node parser, and the one
 * globby/lint-staged/eslint build on. That choice is deliberate and worth
 * stating, because gitignore reimplementations disagree on edge cases (`ignore`
 * vs Python `pathspec` vs git itself) — the behaviour this module depends on is
 * pinned in its paired spec rather than assumed.
 *
 * PURE by design: it never touches the filesystem. The caller reads each
 * `.gitignore` and pushes its contents; keeping the fs out means the semantics
 * are testable without a temp tree, and the walk keeps sole ownership of
 * symlink/containment discipline.
 */
import ignore, { type Ignore } from 'ignore';

/** One `.gitignore`'s rules, scoped to the directory that declared them. */
interface GitignoreScope {
  /** Workspace-relative POSIX directory the file lives in; '' for the root. */
  readonly directory: string;
  readonly matcher: Ignore;
}

export interface GitignoreMatcher {
  /**
   * Whether a DIRECTORY is ignored, given its workspace-relative POSIX path
   * without a trailing slash.
   *
   * Separate from {@link ignoresFile} because it is not a convenience: a
   * directory-only pattern (`dist/`) does NOT match the bare path `dist`, since
   * a bare path carries no directory signal. Asking the file form here would
   * return false, the walk would descend, and it would then reject every file
   * inside one at a time — which is the cap starvation this exists to prevent.
   */
  ignoresDirectory(relativePath: string): boolean;
  /** Whether a FILE is ignored, given its workspace-relative POSIX path. */
  ignoresFile(relativePath: string): boolean;
  /** Leave the most recently pushed scope (the walk is exiting that directory). */
  pop(): void;
  /**
   * Enter a directory that declares a `.gitignore`. `directory` is the
   * workspace-relative POSIX path of the directory itself ('' for the root),
   * and `contents` is the raw file text — empty or comment-only is fine and
   * simply contributes no rules.
   */
  push(directory: string, contents: string): void;
}

function relativeToScope(scopeDirectory: string, relativePath: string): string | undefined {
  if (scopeDirectory === '') {
    return relativePath;
  }
  const prefix = `${scopeDirectory}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}

export function createGitignoreMatcher(): GitignoreMatcher {
  const scopes: GitignoreScope[] = [];

  const isIgnored = (relativePath: string, asDirectory: boolean): boolean => {
    let ignored = false;
    // Outermost first: a deeper `.gitignore` is more specific, so its verdict
    // must be able to overturn an outer one (git resolves the last match wins,
    // and a nested file is evaluated after its parent).
    for (const scope of scopes) {
      const scoped = relativeToScope(scope.directory, relativePath);
      if (scoped === undefined || scoped === '') {
        continue;
      }
      // `ignore` needs the trailing slash to apply directory-only patterns.
      const candidate = asDirectory ? `${scoped}/` : scoped;
      const result = scope.matcher.test(candidate);
      if (result.ignored) {
        ignored = true;
      } else if (result.unignored) {
        ignored = false;
      }
    }
    return ignored;
  };

  return {
    ignoresDirectory: (relativePath) => isIgnored(relativePath, true),
    ignoresFile: (relativePath) => isIgnored(relativePath, false),
    pop: () => {
      scopes.pop();
    },
    push: (directory, contents) => {
      scopes.push({ directory, matcher: ignore().add(contents) });
    },
  };
}
