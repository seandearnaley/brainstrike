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

/**
 * Credential files no agent tool walks, greps, reads or indexes, whatever the
 * ignore files say: environment files (but not their committed templates) and
 * private keys. A FLOOR beneath every layer, not a ninth layer, because a
 * layer can be negated: no `!` pattern in any file and no `includeIgnored`
 * lifts it, and it reads as hard. Live grep does not consult `.gitignore`
 * (BST-1429), so a gitignored `.env.local` was otherwise searchable, and on
 * 2026-10-16 a grep context line carried its API key to the provider.
 */
export const WORKSPACE_SECRET_FILE_PATTERNS: readonly string[] = Object.freeze([
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '*.pem',
  '*.key',
  'id_rsa*',
  // FILES only: gitignore patterns also match directories, so every pattern's
  // directory form is re-included. A `.env.d/` or `keys.key/` directory is
  // walked as usual; only its own credential files are held back.
  '!.env/',
  '!.env.*/',
  '!*.pem/',
  '!*.key/',
  '!id_rsa*/',
]);

const SECRET_FILES = ignore().add([...WORKSPACE_SECRET_FILE_PATTERNS]);

/** Whether a workspace-relative POSIX path is a credential file under the floor. */
export function isWorkspaceSecretFile(relativePath: string, asDirectory = false): boolean {
  const normalized = relativePath.replace(/^\/+/, '');
  return normalized !== '' && SECRET_FILES.ignores(asDirectory ? `${normalized}/` : normalized);
}

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
  /** See {@link ScopePushOptions.pathPrefix}. */
  readonly pathPrefix: string;
  /** Path depth cached once so hot queries never re-split the scope prefix. */
  readonly pathPrefixDepth: number;
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
  /**
   * Whether the HARD agent layers alone exclude this path — i.e. whether
   * `includeIgnored` could ever reveal it.
   *
   * Callers that tell a user "this was excluded, retry with includeIgnored"
   * need this: for a hard exclusion that advice is a dead end, and worse, it
   * discloses that SOMETHING exists at a path the user asked to be invisible.
   * The distinction lives here because the matcher is the only thing that knows
   * which layer decided.
   */
  ignoresHard(relativePath: string, asDirectory: boolean): boolean;
  /** Leave the most recently pushed scope (the walk is exiting that directory). */
  pop(): void;
  /**
   * Enter a directory, supplying whatever ignore files it declares. `directory`
   * is the workspace-relative POSIX path of the directory itself ('' for the
   * root). Pushing an empty object is valid and contributes nothing.
   */
  push(directory: string, sources: WorkspaceIgnoreSources, options?: ScopePushOptions): void;
}

export interface ScopePushOptions {
  /**
   * Path prepended to every candidate before this scope tests it, for an ignore
   * file that lives ABOVE the walk root — a repo-root `.gitignore` when the
   * user opened `packages/web`.
   *
   * Its patterns are written relative to ITS directory, so
   * `packages/web/vendor/` must be tested against `packages/web/vendor/x.ts`,
   * not the `vendor/x.ts` the walk produces. Expressed as a prefix rather than
   * by rewriting the patterns: rebasing gitignore text means reimplementing its
   * syntax (anchors, `**`, globs in the prefix), which is the hand-rolling this
   * module exists to avoid.
   */
  pathPrefix?: string;
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
  includeIgnored: boolean,
  pathPrefix: string
): CompiledScope {
  return {
    bypassable: includeIgnored ? undefined : compileGroup(sources, BYPASSABLE_LAYERS),
    directory,
    hard: compileGroup(sources, HARD_LAYERS),
    pathPrefix,
    pathPrefixDepth: pathPrefix.split('/').filter(Boolean).length,
  };
}

function relativeToScope(scopeDirectory: string, relativePath: string): string | undefined {
  if (scopeDirectory === '') {
    return relativePath;
  }
  const prefix = `${scopeDirectory}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}

interface PathNode {
  readonly candidate: string;
  readonly stateKey: string;
}

type IgnoreTestResult = ReturnType<Ignore['test']>;

// `ignore.test()` memoizes inherited verdicts, which are intentionally unusable
// for cross-scope resolution. Mirror that cache at the direct-rule boundary so
// sibling entries do not re-run the same ancestor regexes during a walk. The
// matcher owns immutable, fully compiled rules, and the WeakMap releases each
// candidate cache with its compiled scope.
const directTestCache = new WeakMap<Ignore, Map<string, IgnoreTestResult>>();

/**
 * `ignore.test()` deliberately returns an excluded parent's cached verdict for
 * every descendant. Cross-scope resolution needs the rule manager's direct
 * path verdict instead so that a deeper scope can re-include the parent while a
 * leaf-specific rule in the outer scope still wins at the leaf. This structural
 * dependency is pinned to ignore@7.0.5 in the workspace catalog; throw if that
 * contract moves instead of silently reverting to inherited verdicts.
 */
function directTest(matcher: Ignore, candidate: string): IgnoreTestResult {
  let matcherCache = directTestCache.get(matcher);
  const cached = matcherCache?.get(candidate);
  if (cached !== undefined) {
    return cached;
  }
  const ruleManager = (
    matcher as unknown as {
      readonly _rules?: {
        readonly test?: (
          path: string,
          checkUnignored: boolean,
          mode: 'regex'
        ) => ReturnType<Ignore['test']>;
      };
    }
  )._rules;
  if (typeof ruleManager?.test !== 'function') {
    throw new Error(
      'ignore@7.0.5 direct rule evaluation is unavailable; refusing to apply incomplete cross-scope ignore semantics.'
    );
  }
  const result = ruleManager.test(candidate, true, 'regex');
  if (matcherCache === undefined) {
    matcherCache = new Map<string, IgnoreTestResult>();
    directTestCache.set(matcher, matcherCache);
  }
  matcherCache.set(candidate, result);
  return result;
}

function longestPathPrefix(scopes: readonly CompiledScope[]): string {
  let longest = '';
  let longestDepth = 0;
  for (const scope of scopes) {
    if (scope.pathPrefixDepth > longestDepth) {
      longest = scope.pathPrefix;
      longestDepth = scope.pathPrefixDepth;
    }
  }
  return longest;
}

function scopeBasePath(rootPrefix: string, scope: CompiledScope): string {
  if (scope.pathPrefix === '') {
    return [rootPrefix, scope.directory].filter(Boolean).join('/');
  }
  if (rootPrefix === scope.pathPrefix) {
    return '';
  }
  const suffix = `/${scope.pathPrefix}`;
  if (!rootPrefix.endsWith(suffix)) {
    throw new Error(
      `Ignore scope prefix "${scope.pathPrefix}" is not a suffix of opened-root prefix "${rootPrefix}".`
    );
  }
  return rootPrefix.slice(0, -suffix.length);
}

/** Address each containing component in the coordinate space of its ignore file. */
function pathNodesForScope(
  scope: CompiledScope,
  relativePath: string,
  asDirectory: boolean,
  rootPrefix: string
): readonly PathNode[] {
  const scoped = relativeToScope(scope.directory, relativePath);
  if (scoped === undefined) {
    return [];
  }
  const candidatePath = [scope.pathPrefix, scoped].filter(Boolean).join('/');
  if (candidatePath === '') {
    return [];
  }
  const candidateSegments = candidatePath.split('/');
  const basePath = scopeBasePath(rootPrefix, scope);
  return candidateSegments.map((_, index) => {
    const candidate = candidateSegments.slice(0, index + 1).join('/');
    const final = index === candidateSegments.length - 1;
    return {
      candidate: !final || asDirectory ? `${candidate}/` : candidate,
      stateKey: [basePath, candidate].filter(Boolean).join('/'),
    };
  });
}

function applyNodeResult(
  result: ReturnType<Ignore['test']>,
  stateKey: string,
  states: Map<string, boolean>
): void {
  if (result.unignored) {
    states.set(stateKey, false);
    return;
  }
  if (result.ignored) {
    states.set(stateKey, true);
  }
}

/**
 * Apply one precedence group across every scope and path component.
 *
 * Direct per-node verdicts preserve distinct containing-directory states. That
 * lets a deeper scope re-include one directory without erasing an excluded
 * ancestor, a leaf-specific exclusion, or a later match of one unanchored rule.
 * No pattern syntax is inspected or rewritten; `ignore` remains the semantic
 * authority (BST-1434).
 */
function applyGroup(
  scopes: readonly CompiledScope[],
  relativePath: string,
  asDirectory: boolean,
  states: Map<string, boolean>,
  rootPrefix: string,
  hardOnly: boolean
): void {
  for (const scope of scopes) {
    const matcher = hardOnly ? scope.hard : scope.bypassable;
    if (matcher === undefined) {
      continue;
    }
    for (const node of pathNodesForScope(scope, relativePath, asDirectory, rootPrefix)) {
      applyNodeResult(directTest(matcher, node.candidate), node.stateKey, states);
    }
  }
}

function applyResult(current: boolean, result: ReturnType<Ignore['test']>): boolean {
  if (result.unignored) {
    return false;
  }
  return result.ignored || current;
}

function singleRootScopeVerdict(
  scope: CompiledScope,
  relativePath: string,
  asDirectory: boolean,
  hardOnly: boolean
): boolean {
  const segments = relativePath.split('/');
  let candidatePath = '';
  for (const [index, segment] of segments.entries()) {
    candidatePath = candidatePath === '' ? segment : `${candidatePath}/${segment}`;
    const final = index === segments.length - 1;
    const candidate = !final || asDirectory ? `${candidatePath}/` : candidatePath;
    let ignored = false;
    if (!(hardOnly || scope.bypassable === undefined)) {
      ignored = applyResult(ignored, directTest(scope.bypassable, candidate));
    }
    if (scope.hard !== undefined) {
      ignored = applyResult(ignored, directTest(scope.hard, candidate));
    }
    if (ignored) {
      return true;
    }
  }
  return false;
}

export function createWorkspaceIgnoreMatcher(
  options?: WorkspaceIgnoreMatcherOptions
): WorkspaceIgnoreMatcher {
  const includeIgnored = options?.includeIgnored === true;
  const scopes: CompiledScope[] = [];

  const isIgnored = (relativePath: string, asDirectory: boolean, hardOnly = false): boolean => {
    if (isWorkspaceSecretFile(relativePath, asDirectory)) {
      return true;
    }
    const onlyScope = scopes.length === 1 ? scopes[0] : undefined;
    if (
      onlyScope !== undefined &&
      onlyScope.directory === '' &&
      onlyScope.pathPrefix === '' &&
      relativePath !== ''
    ) {
      return singleRootScopeVerdict(onlyScope, relativePath, asDirectory, hardOnly);
    }
    const rootPrefix = longestPathPrefix(scopes);
    const states = new Map<string, boolean>();
    // TWO passes, not one interleaved walk, and the split is the whole point.
    //
    // Within a group, outermost scope first: a deeper file is more specific
    // than its parent and must be able to overturn it (ripgrep's model, and
    // git's last-match-wins). But the groups are resolved GLOBALLY — every
    // bypassable scope, then every hard scope — because a scope-major fold
    // quietly makes the agent layers bypassable: apply the root `.llmignore`,
    // then a nested `.gitignore` carrying `!key.ts`, and the negation wins.
    // Anyone who can add a nested gitignore could then defeat the boundary.
    if (!hardOnly) {
      applyGroup(scopes, relativePath, asDirectory, states, rootPrefix, false);
    }
    applyGroup(scopes, relativePath, asDirectory, states, rootPrefix, true);
    return [...states.values()].some(Boolean);
  };

  return {
    ignoresDirectory: (relativePath) => isIgnored(relativePath, true),
    ignoresFile: (relativePath) => isIgnored(relativePath, false),
    ignoresHard: (relativePath, asDirectory) => isIgnored(relativePath, asDirectory, true),
    pop: () => {
      scopes.pop();
    },
    push: (directory, sources, pushOptions) => {
      scopes.push(compileScope(directory, sources, includeIgnored, pushOptions?.pathPrefix ?? ''));
    },
  };
}
