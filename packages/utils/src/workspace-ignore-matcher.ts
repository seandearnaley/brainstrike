/**
 * Ignore-file semantics for a workspace walk (BST-1427, BST-1430).
 *
 * A hand-maintained denylist of directory names cannot keep up with the caches
 * a real machine accumulates, and when it falls behind the failure is SILENT: a
 * glob returns `0 matches` rather than an error. Every directory that has hurt
 * us — `.pnpm-store` (82k files), `.turbo`, `.claude/worktrees` — was already
 * ignored by a file someone had already written.
 *
 * ONE precedence order, lowest priority first. Every layer can override the one
 * beneath it, including with a `!` re-include, exactly as git resolves
 * last-match-wins:
 *
 *   1. global excludes  — `core.excludesFile`, machine-wide defaults
 *   2. `.git/info/exclude` — repo-local, uncommitted
 *   3. parent `.gitignore` — when the root sits inside a larger repo
 *   4. `.gitignore`       — root, then nested (deeper wins)
 *   5. `.ignore`          — "hide from search, keep in git"
 *   6. `.rgignore`        — ripgrep's own highest layer
 *   7. `.llmignore`       — portable agent ignore file .......... HARD
 *   8. `.brainstrikeignore` — ours, wins over the portable one ... HARD
 *
 * Sources 1-3 are the git chain the article documents; 4-6 mirror ripgrep's.
 * Implementation is the `ignore` package — the de-facto Node parser — chosen
 * deliberately and pinned by the paired spec, because gitignore
 * reimplementations disagree on edge cases.
 *
 * THE AGENT LAYERS ARE A HARD BOUNDARY (7-8). `includeIgnored` bypasses every
 * other layer, because tools legitimately search excluded trees — but it does
 * NOT bypass these. They are the only exclusion a user may reasonably treat as
 * a security control (credentials, customer data, a private corpus), and a
 * promise of "never read, index, or send" that one flag defeats is worse than
 * no promise, because people rely on it. That asymmetry is deliberate: a caller
 * reaching for `includeIgnored` does not hold a master key.
 *
 * PURE by design: it never touches the filesystem. The caller reads each file
 * and pushes its contents, which keeps the semantics testable without a temp
 * tree and leaves the walk sole owner of symlink/containment discipline.
 */
import ignore, { type Ignore } from 'ignore';

/**
 * Raw contents of the ignore files found in ONE directory. Every field is
 * optional; an absent file simply contributes no rules.
 */
export interface WorkspaceIgnoreSources {
  /** `.brainstrikeignore` — HARD, highest priority. */
  brainstrikeignore?: string | undefined;
  /** `.gitignore`. */
  gitignore?: string | undefined;
  /** Machine-wide `core.excludesFile`; only meaningful at the root scope. */
  globalExcludes?: string | undefined;
  /** `.ignore`. */
  ignore?: string | undefined;
  /** `.git/info/exclude`; only meaningful at the root scope. */
  infoExclude?: string | undefined;
  /** `.llmignore` — HARD. */
  llmignore?: string | undefined;
  /** `.rgignore`. */
  rgignore?: string | undefined;
}

/** Layer order within one scope, lowest priority first. See the module note. */
const BYPASSABLE_LAYERS = [
  'globalExcludes',
  'infoExclude',
  'gitignore',
  'ignore',
  'rgignore',
] as const satisfies readonly (keyof WorkspaceIgnoreSources)[];

/** Layers `includeIgnored` must NOT bypass, lowest priority first. */
const HARD_LAYERS = [
  'llmignore',
  'brainstrikeignore',
] as const satisfies readonly (keyof WorkspaceIgnoreSources)[];

interface CompiledScope {
  /**
   * Bypassable layers 1-6, CONCATENATED in precedence order into a single
   * matcher, or undefined when none apply. See {@link compileScope}.
   */
  readonly bypassable: Ignore | undefined;
  /** Workspace-relative POSIX directory that declared these; '' for the root. */
  readonly directory: string;
  /** Hard layers 7-8, likewise concatenated. */
  readonly hard: Ignore | undefined;
}

export interface WorkspaceIgnoreMatcher {
  /**
   * Whether a DIRECTORY is ignored, given its workspace-relative POSIX path
   * WITHOUT a trailing slash.
   *
   * Separate from {@link ignoresFile} because it is not a convenience: a
   * directory-only pattern (`dist/`) does NOT match the bare path `dist`, since
   * a bare path carries no directory signal. Asking the file form here returns
   * false, the walk descends, and it then rejects every file inside one at a
   * time — the cap starvation this exists to prevent.
   */
  ignoresDirectory(relativePath: string): boolean;
  /** Whether a FILE is ignored, given its workspace-relative POSIX path. */
  ignoresFile(relativePath: string): boolean;
  /** Leave the most recently pushed scope (the walk is exiting that directory). */
  pop(): void;
  /**
   * Enter a directory, supplying whatever ignore files it declares. `directory`
   * is the workspace-relative POSIX path of the directory itself ('' for the
   * root). Pushing an empty object is valid and contributes nothing.
   */
  push(directory: string, sources: WorkspaceIgnoreSources): void;
}

export interface WorkspaceIgnoreMatcherOptions {
  /**
   * Skip the bypassable layers, as the walk's `includeIgnored` does. The HARD
   * agent layers still apply — see the module note for why.
   */
  includeIgnored?: boolean;
}

/**
 * Join the layers of one group into ONE matcher, in precedence order.
 *
 * Concatenation is the whole trick, and it is not a micro-optimisation. A
 * separate `Ignore` per layer forces the CALLER to combine verdicts, and that
 * combination is where gitignore is genuinely hard. Given `.gitignore: cache/`
 * and `.ignore: !cache/`, per-layer instances report, for the FILE
 * `cache/one.md`:
 *
 *   `cache/`  -> { ignored: true }     <- directory-only pattern, matched flat
 *   `!cache/` -> { }                   <- no verdict; it negates the DIRECTORY
 *
 * so any last-match-wins fold keeps the file excluded, while git (verified with
 * `git check-ignore`) does not. One instance holding both patterns returns
 * `{ ignored: false }` — git's answer — because resolution happens inside the
 * parser, which knows the rules that produced each match.
 *
 * So: never fold verdicts across patterns that share a precedence order. Hand
 * the ordered patterns to the parser and let it resolve them.
 */
function compileGroup(
  sources: WorkspaceIgnoreSources,
  keys: readonly (keyof WorkspaceIgnoreSources)[]
): Ignore | undefined {
  const contents: string[] = [];
  for (const key of keys) {
    const value = sources[key];
    if (value !== undefined) {
      contents.push(value);
    }
  }
  return contents.length > 0 ? ignore().add(contents.join('\n')) : undefined;
}

function compileScope(
  directory: string,
  sources: WorkspaceIgnoreSources,
  includeIgnored: boolean
): CompiledScope {
  return {
    bypassable: includeIgnored ? undefined : compileGroup(sources, BYPASSABLE_LAYERS),
    directory,
    hard: compileGroup(sources, HARD_LAYERS),
  };
}

function relativeToScope(scopeDirectory: string, relativePath: string): string | undefined {
  if (scopeDirectory === '') {
    return relativePath;
  }
  const prefix = `${scopeDirectory}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}

/**
 * Fold ONE scope's verdict over the verdict so far, returning the new verdict.
 *
 * A scope that does not contain the path, or declares nothing, leaves `ignored`
 * untouched — absence of a rule is not a verdict.
 */
function applyScope(
  scope: CompiledScope,
  relativePath: string,
  asDirectory: boolean,
  ignoredSoFar: boolean
): boolean {
  const scoped = relativeToScope(scope.directory, relativePath);
  if (scoped === undefined || scoped === '') {
    return ignoredSoFar;
  }
  // `ignore` needs the trailing slash to apply directory-only patterns.
  const candidate = asDirectory ? `${scoped}/` : scoped;
  let ignored = ignoredSoFar;
  // Bypassable before hard: the agent layers are the higher precedence, so a
  // `!` re-include in `.llmignore` can still overturn a `.gitignore` rule.
  for (const matcher of [scope.bypassable, scope.hard]) {
    const result = matcher?.test(candidate);
    if (result?.ignored) {
      ignored = true;
    } else if (result?.unignored) {
      ignored = false;
    }
  }
  return ignored;
}

export function createWorkspaceIgnoreMatcher(
  options?: WorkspaceIgnoreMatcherOptions
): WorkspaceIgnoreMatcher {
  const includeIgnored = options?.includeIgnored === true;
  const scopes: CompiledScope[] = [];

  const isIgnored = (relativePath: string, asDirectory: boolean): boolean => {
    let ignored = false;
    // Outermost scope first: a deeper `.gitignore` is more specific than its
    // parent, so a deeper verdict must be able to overturn a shallower one
    // (git resolves last-match-wins).
    for (const scope of scopes) {
      ignored = applyScope(scope, relativePath, asDirectory, ignored);
    }
    return ignored;
  };

  return {
    ignoresDirectory: (relativePath) => isIgnored(relativePath, true),
    ignoresFile: (relativePath) => isIgnored(relativePath, false),
    pop: () => {
      scopes.pop();
    },
    push: (directory, sources) => {
      scopes.push(compileScope(directory, sources, includeIgnored));
    },
  };
}
