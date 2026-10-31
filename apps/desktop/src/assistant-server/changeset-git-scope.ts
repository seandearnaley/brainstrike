/**
 * `git-scope`-sourced `ChangesetView`/`fileDiff` resolution (BST-1113) — split
 * out of `changeset-diff-service.ts` to keep that file under its line-count
 * budget. See that module's doc comment for the overall dispatch.
 *
 * `git-service.ts` and `git-structured-diff.ts` MUST NOT GROW (both are at
 * their line-count ceiling), so this module invokes `git` DIRECTLY via its own
 * thin `InvokeFn` closure over the injected raw `GitCommandRunner` for
 * operations `createGitService` does not expose as an op (numstat/name-status
 * listing, `merge-base`, `rev-parse`, `symbolic-ref`) — reusing every existing
 * EXPORTED helper (`describeFailure`, `stripLineEnding`, `parsePorcelainV2Z`,
 * `scopeStatusPaths`, `resolveContainedPathArg`, `assertUntrackedDiffPathContained`)
 * rather than re-deriving them. Only `structuredFileDiff` itself goes through
 * `createGitService({ cwd, run })`, per the plan's explicit instruction to
 * reuse the W1 engine for per-file content.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  ChangedFileEntry,
  ChangedFileStatus,
  Changeset,
  ChangesetView,
  GitScope,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';
import type { RootCwdResult } from '../workspace-root-cwd';
import {
  describeFailure,
  gitCommandFailed,
  gitInvalid,
  gitRefused,
  gitUnexpected,
} from './git-failure';
import { parseCommitFiles } from './git-repository-parsers';
import {
  createGitService,
  GIT_DEFAULT_TIMEOUT_MS,
  type GitCommandRun,
  type GitCommandRunner,
  parsePorcelainV2Z,
  scopeStatusPaths,
  stripLineEnding,
} from './git-service';
import {
  resolveCommitOldRef,
  resolveEmptyTreeHash,
  validateBaseRef,
  validateCommitId,
} from './git-structured-diff-refs';
import { parseNumstatZ } from './structured-diff-parsers';

type GitScopeChangeset = Extract<Changeset, { kind: 'git-scope' }>;

type InvokeFn = (args: readonly string[], timeoutMs?: number) => Promise<GitCommandRun>;

function createInvoke(cwd: string, run: GitCommandRunner): InvokeFn {
  return async (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) => await run({ args, cwd, timeoutMs });
}

/**
 * Pure, segment-aware containment predicate: `candidatePath` is "contained"
 * by `parentPath` when it IS `parentPath`, or a genuine descendant of it.
 * `path.relative` makes this segment-aware by construction — `/a/foo` is NOT
 * contained in `/a/f` because `path.relative('/a/f', '/a/foo')` is `'../foo'`
 * (a `..`-prefixed relative path), never a naive string-prefix match.
 * Exported so the property is directly unit-testable without touching the
 * filesystem (the async realpath resolution around it is what needs real
 * paths; this predicate does not).
 */
export function isPathContained(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  if (relative === '') {
    return true;
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return false;
  }
  return !path.isAbsolute(relative);
}

/**
 * Narrow a renderer-supplied `rootId` to a non-empty string BEFORE it does
 * anything else. `resolveRootCwd` (`workspace-root-cwd.ts`) already rejects a
 * non-string internally, so this is not a fallback for a case that would
 * otherwise slip through — it exists so the STRING VALUE is available,
 * honestly typed, to callers that need to reuse it (e.g.
 * `resolveGitScopeChangesetView` populating `ChangedFileEntry.rootId`)
 * without re-deriving it via a `typeof` check that would read as tolerating
 * a non-string input this module never actually accepts.
 */
function requireStringRootId(rootId: unknown): BoundaryResult<string> {
  if (typeof rootId !== 'string') {
    return gitInvalid('git-scope resolution requires a non-empty rootId string.');
  }
  // Return the TRIMMED value (NTH-2, review finding): `resolveRootCwd`
  // (`workspace-root-cwd.ts`) matches against the trimmed rootId internally,
  // so returning the untrimmed input here would let a padded rootId resolve
  // successfully while still shipping a `ChangedFileEntry.rootId` the
  // renderer's OWN (trimmed) root-id values can never match.
  const trimmed = rootId.trim();
  if (trimmed.length === 0) {
    return gitInvalid('git-scope resolution requires a non-empty rootId string.');
  }
  return { ok: true, value: trimmed };
}

/**
 * git-scope containment (settled v1 policy): resolve the caller's `rootId` via
 * the audited `resolveRootCwd` seam, realpath the changeset's `worktreePath`,
 * and verify the root CONTAINS the worktree by {@link isPathContained}. No
 * containing root ⇒ `outside-roots-unsupported:` (out-of-root worktrees need
 * W2's trust-validated inventory; W4 integrates). cwd = the realpath'd
 * `worktreePath`.
 */
async function resolveContainedWorktreeCwd(
  resolveRootCwd: (rootId: unknown) => Promise<RootCwdResult>,
  rootId: unknown,
  worktreePath: string
): Promise<BoundaryResult<string>> {
  const rootCwd = await resolveRootCwd(rootId);
  if (!rootCwd.ok) {
    return gitRefused('input', 'workspace.root-unresolved', rootCwd.error);
  }
  let worktreeReal: string;
  try {
    worktreeReal = await realpath(worktreePath);
  } catch {
    return gitRefused(
      'authorization',
      'changeset.outside-roots',
      `git-scope worktreePath "${worktreePath}" could not be resolved on disk.`
    );
  }
  if (!isPathContained(rootCwd.value, worktreeReal)) {
    return gitRefused(
      'authorization',
      'changeset.outside-roots',
      `worktree "${worktreePath}" is not contained by the resolved workspace root.`
    );
  }
  return { ok: true, value: worktreeReal };
}

/** `HEAD` is unborn (no commits yet) when `rev-parse --verify --quiet HEAD`
 * fails to resolve a commit. */
async function isHeadUnborn(invoke: InvokeFn): Promise<boolean> {
  const run_ = await invoke(['rev-parse', '--verify', '--quiet', 'HEAD']);
  return run_.exitCode !== 0;
}

/**
 * Base-ref resolution for `branch-vs-base` (settled, hard): explicit
 * `baseRef` wins; else `git symbolic-ref refs/remotes/origin/HEAD`; else a
 * fallback probe for `refs/remotes/origin/main`; else a visible typed error.
 * NEVER `@{u}` — that upstream-tracking form is deliberately never used
 * anywhere in this module.
 */
async function resolveDefaultBaseRef(invoke: InvokeFn): Promise<BoundaryResult<string>> {
  const symbolicRun = await invoke(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolicRun.exitCode === 0) {
    const ref = stripLineEnding(symbolicRun.stdout)
      .trim()
      .replace(/^refs\/remotes\//u, '');
    if (ref.length > 0) {
      return { ok: true, value: ref };
    }
  }
  const probeRun = await invoke(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  if (probeRun.exitCode === 0) {
    return { ok: true, value: 'origin/main' };
  }
  return gitRefused(
    'input',
    'changeset.base-ref-unresolved',
    'could not resolve "origin/HEAD" or "origin/main"; specify an explicit baseRef.'
  );
}

async function resolveExplicitOrDefaultBaseRef(
  invoke: InvokeFn,
  scope: Extract<GitScope, { kind: 'branch-vs-base' }>
): Promise<BoundaryResult<string>> {
  return scope.baseRef === undefined
    ? await resolveDefaultBaseRef(invoke)
    : validateBaseRef(scope.baseRef);
}

/**
 * Resolve the `branch-vs-base` old/new ref PAIR — shared by BOTH the scope
 * listing and per-file `fileDiff` so they can never disagree (the CRITICAL
 * 3a-review finding: `range` mode must receive the MERGE-BASE, not the raw
 * base ref). Unborn HEAD (no commits yet) ⇒ both sides are THIS repository's
 * empty-tree hash (SHA-1 or SHA-256, resolved per-repo — review finding, see
 * `git-structured-diff-refs.ts`'s `resolveEmptyTreeHash`) — there is no
 * branch tip to diff against. `unborn` is returned alongside (rather than
 * making callers compare `oldRef`/`newRef` back against a hardcoded
 * constant, which can no longer work now the hash varies by repo) so
 * {@link resolveGitScopeStructuredFileDiffParams} can detect this case
 * without re-deriving the hash or re-probing HEAD.
 */
async function resolveBranchVsBaseRefs(
  invoke: InvokeFn,
  scope: Extract<GitScope, { kind: 'branch-vs-base' }>
): Promise<BoundaryResult<{ newRef: string; oldRef: string; unborn: boolean }>> {
  if (await isHeadUnborn(invoke)) {
    const emptyTree = await resolveEmptyTreeHash(invoke);
    if (!emptyTree.ok) {
      return emptyTree;
    }
    return { ok: true, value: { newRef: emptyTree.value, oldRef: emptyTree.value, unborn: true } };
  }
  const baseRef = await resolveExplicitOrDefaultBaseRef(invoke, scope);
  if (!baseRef.ok) {
    return baseRef;
  }
  const mergeBaseRun = await invoke(['merge-base', baseRef.value, 'HEAD']);
  if (mergeBaseRun.exitCode !== 0) {
    return gitRefused(
      'conflict',
      'changeset.merge-base-unresolved',
      `could not resolve merge-base between "${baseRef.value}" and HEAD: ${describeFailure(mergeBaseRun)}`
    );
  }
  return {
    ok: true,
    value: { newRef: 'HEAD', oldRef: stripLineEnding(mergeBaseRun.stdout).trim(), unborn: false },
  };
}

function isSafeRevArg(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && !/\s/u.test(value) && !value.startsWith('-')
  );
}

/**
 * Resolve a possibly-abbreviated, renderer-supplied `commitId` to a FULL
 * object id (the 3a-review CRITICAL finding: the `structuredFileDiff` engine's
 * `commit` mode rejects anything shorter than 40 hex chars). `^{commit}`
 * additionally asserts the id names a commit object, not a blob/tree/tag.
 */
async function resolveFullCommitId(
  invoke: InvokeFn,
  commitId: unknown
): Promise<BoundaryResult<string>> {
  if (!isSafeRevArg(commitId)) {
    return gitInvalid('commitId must be a non-empty string with no leading "-" or whitespace');
  }
  const run_ = await invoke(['rev-parse', '--verify', '--quiet', `${commitId}^{commit}`]);
  if (run_.exitCode !== 0) {
    return gitRefused(
      'input',
      'changeset.commit-id-unresolved',
      `"${commitId}" does not resolve to a commit in this repository.`
    );
  }
  return validateCommitId(stripLineEnding(run_.stdout).trim());
}

interface ScopeChangeRecord {
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly oldPath: string | null;
  readonly path: string;
  readonly status: ChangedFileStatus;
}

/**
 * `git diff --name-status` single-char status codes → {@link ChangedFileStatus}
 * (R3, review finding): `parseCommitFiles`'s regex (`git-repository-parsers.ts`)
 * legitimately emits `A/C/D/M/R/T/U/X/B`, not just `A/D/M/R` — an unmapped
 * code previously failed the ENTIRE scope listing (verified against a real
 * repo: a symlink↔regular-file swap, status `T`, made `uncommitted` /
 * `staged` / `unstaged` / `commit` unusable for the WHOLE changeset, not just
 * that one file). Settled mapping:
 * - `T` (typechange, e.g. symlink↔regular file) → `'modified'`: both sides
 *   exist and their content differs — an honest fit, no new status needed.
 * - `C` (copy — only possible with an explicit `--find-copies`/`-C` flag,
 *   which this module never passes, so `C` should not occur today; mapped
 *   defensively anyway) → `'added'`: a copy's destination is a NEW path.
 * - `U` (unmerged) is NOT in this map — handled as a hard, dedicated,
 *   `unmerged-path:`-prefixed error in {@link listRefComparisonChanges},
 *   matching W1's unmerged-surfacing posture in `git-structured-diff.ts`
 *   (`CAT_FILE_UNMERGED_STDERR_PATTERN`): a conflicted path has a real,
 *   structured reason it can't be diffed, and silently reporting it as any
 *   other status would be misleading, not just imprecise.
 * - `X`/`B` (git-internal "unknown"/"broken pairing" — not expected in
 *   practice) fall through to the generic "unsupported file status" error
 *   below, scoped to the ONE offending path.
 */
const NAME_STATUS_TO_CHANGED_STATUS: ReadonlyMap<string, ChangedFileStatus> = new Map([
  ['A', 'added'],
  ['C', 'added'],
  ['D', 'deleted'],
  ['M', 'modified'],
  ['R', 'renamed'],
  ['T', 'modified'],
]);

/**
 * List every changed path for a two-way `git diff` TARGET (`[]` = index vs
 * worktree, `['HEAD']`/`['--cached']` = one ref vs the worktree/index,
 * `[oldRef, newRef]` = two explicit refs) via TWO invocations —
 * `--numstat` (counts + rename pairs) and `--name-status` (status
 * classification, see {@link NAME_STATUS_TO_CHANGED_STATUS}) — merged by
 * final path. Two calls are needed because `--numstat` alone carries no
 * add/delete/modify classification. `-z` NUL parsing and rename-triple
 * decoding reuse the existing parsers (`parseNumstatZ`, `parseCommitFiles`)
 * rather than a hand-rolled second `-z` parser.
 *
 * The merge is checked in BOTH directions: every numstat entry must have a
 * matching name-status entry, AND every name-status entry must have a
 * matching numstat entry. Checking only one direction would silently drop
 * whichever side's extra entries went unchecked — the two invocations run
 * against the SAME target and flags, so in the absence of a genuine git bug
 * their path sets must be identical; a mismatch in EITHER direction is
 * reported as a visible error, never silently ignored.
 */
async function listRefComparisonChanges(
  invoke: InvokeFn,
  target: readonly string[]
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  const [numstatRun, nameStatusRun] = await Promise.all([
    invoke(['diff', ...target, '--numstat', '-z', '--relative', '--find-renames']),
    invoke(['diff', ...target, '--name-status', '-z', '--relative', '--find-renames']),
  ]);
  if (numstatRun.exitCode !== 0) {
    return gitCommandFailed(numstatRun);
  }
  if (nameStatusRun.exitCode !== 0) {
    return gitCommandFailed(nameStatusRun);
  }
  const numstatEntries = parseNumstatZ(numstatRun.stdout);
  const nameStatusEntries = parseCommitFiles(nameStatusRun.stdout);
  const statusByPath = new Map(nameStatusEntries.map((entry) => [entry.path, entry]));
  const numstatPaths = new Set(numstatEntries.map((entry) => entry.path));

  for (const statusEntry of nameStatusEntries) {
    if (!numstatPaths.has(statusEntry.path)) {
      return gitUnexpected(
        `git name-status reported "${statusEntry.path}" with no matching numstat entry`
      );
    }
  }

  const records: ScopeChangeRecord[] = [];
  for (const numstatEntry of numstatEntries) {
    const statusEntry = statusByPath.get(numstatEntry.path);
    if (!statusEntry) {
      return gitUnexpected(
        `git numstat reported "${numstatEntry.path}" with no matching name-status entry`
      );
    }
    if (statusEntry.status === 'U') {
      // DEFENSIVE (NTH-5, review finding): `git diff --name-status` reports
      // an UNRESOLVED merge conflict as `M` with real numstat counts, NOT
      // `U` (empirically confirmed) — `--diff-filter=U`/status `U` is a
      // `git status` concept, not a `git diff` one. This branch guards the
      // documented, intentional posture (never silently misreport a
      // conflicted path) for whatever future git version, flag, or scope
      // this module doesn't yet cover MIGHT emit `U` from `--name-status`;
      // it is not known to be reachable today.
      return gitRefused(
        'conflict',
        'changeset.unmerged-path',
        `"${statusEntry.path}" has unresolved merge conflicts — resolve them before viewing this scope's diff.`
      );
    }
    const mappedStatus = NAME_STATUS_TO_CHANGED_STATUS.get(statusEntry.status);
    if (!mappedStatus) {
      return gitUnexpected(
        `git reported an unsupported file status "${statusEntry.status}" for "${numstatEntry.path}"`
      );
    }
    records.push({
      additions: numstatEntry.additions,
      deletions: numstatEntry.deletions,
      oldPath: mappedStatus === 'renamed' ? numstatEntry.oldPath : null,
      path: numstatEntry.path,
      status: mappedStatus,
    });
  }
  return { ok: true, value: records };
}

/** Untracked files (`uncommitted` scope only — `unstaged`/`staged` never
 * include them: an untracked file is by definition not in the index). Numstat
 * has no concept of an untracked file (`git diff` never diffs one), so
 * `additions`/`deletions` are honestly `null` here, matching the binary
 * convention — never a fabricated count from reading the file. */
async function listUntrackedChanges(
  invoke: InvokeFn
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  const [statusRun, prefixRun] = await Promise.all([
    invoke(['status', '--porcelain=v2', '--untracked-files=all', '-z', '--', '.']),
    invoke(['rev-parse', '--show-prefix']),
  ]);
  if (statusRun.exitCode !== 0) {
    return gitCommandFailed(statusRun);
  }
  if (prefixRun.exitCode !== 0) {
    return gitCommandFailed(prefixRun);
  }
  const scoped = scopeStatusPaths(
    parsePorcelainV2Z(statusRun.stdout),
    stripLineEnding(prefixRun.stdout)
  );
  if (!scoped.ok) {
    return scoped;
  }
  const records: ScopeChangeRecord[] = [];
  for (const file of scoped.value.files) {
    if (file.untracked) {
      records.push({
        additions: null,
        deletions: null,
        oldPath: null,
        path: file.path,
        status: 'untracked',
      });
    }
  }
  return { ok: true, value: records };
}

async function resolveUncommittedChanges(
  invoke: InvokeFn
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  const unborn = await isHeadUnborn(invoke);
  let oldTarget = 'HEAD';
  if (unborn) {
    const emptyTree = await resolveEmptyTreeHash(invoke);
    if (!emptyTree.ok) {
      return emptyTree;
    }
    oldTarget = emptyTree.value;
  }
  const tracked = await listRefComparisonChanges(invoke, [oldTarget]);
  if (!tracked.ok) {
    return tracked;
  }
  const untracked = await listUntrackedChanges(invoke);
  if (!untracked.ok) {
    return untracked;
  }
  return { ok: true, value: [...tracked.value, ...untracked.value] };
}

/** Scope → change listing dispatch. See this module's doc comment for why
 * numstat/name-status are invoked directly rather than through
 * `createGitService`, which has no listing op. */
async function resolveScopeChanges(
  invoke: InvokeFn,
  scope: GitScope
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  switch (scope.kind) {
    case 'uncommitted':
      return await resolveUncommittedChanges(invoke);
    case 'unstaged':
      return await listRefComparisonChanges(invoke, []);
    case 'staged': {
      const unborn = await isHeadUnborn(invoke);
      if (!unborn) {
        return await listRefComparisonChanges(invoke, ['--cached']);
      }
      const emptyTree = await resolveEmptyTreeHash(invoke);
      if (!emptyTree.ok) {
        return emptyTree;
      }
      return await listRefComparisonChanges(invoke, ['--cached', emptyTree.value]);
    }
    case 'commit': {
      const fullId = await resolveFullCommitId(invoke, scope.commitId);
      if (!fullId.ok) {
        return fullId;
      }
      const oldRef = await resolveCommitOldRef(invoke, fullId.value);
      if (!oldRef.ok) {
        return oldRef;
      }
      return await listRefComparisonChanges(invoke, [oldRef.value, fullId.value]);
    }
    case 'branch-vs-base': {
      const refs = await resolveBranchVsBaseRefs(invoke, scope);
      if (!refs.ok) {
        return refs;
      }
      return await listRefComparisonChanges(invoke, [refs.value.oldRef, refs.value.newRef]);
    }
    default: {
      const exhaustive: never = scope;
      return gitUnexpected(`unsupported git scope: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface GitScopeDeps {
  readonly resolveRootCwd: (rootId: unknown) => Promise<RootCwdResult>;
  readonly run: GitCommandRunner;
}

/**
 * Resolve a `git-scope` changeset's `ChangesetView`. Totals are summed from
 * numstat; a binary file's null additions/deletions are EXCLUDED from the sum
 * (never coerced to 0 — the entry itself still appears with `additions: null`).
 * `revertible` is honestly `false` for every entry: git-scope changesets have
 * no journal-backed undo path (that concept applies only to `agent-run`/
 * `run-range` changesets).
 */
export async function resolveGitScopeChangesetView(
  deps: GitScopeDeps,
  rootId: unknown,
  changeset: GitScopeChangeset
): Promise<BoundaryResult<ChangesetView>> {
  const rootIdResult = requireStringRootId(rootId);
  if (!rootIdResult.ok) {
    return rootIdResult;
  }
  const cwdResult = await resolveContainedWorktreeCwd(
    deps.resolveRootCwd,
    rootIdResult.value,
    changeset.worktreePath
  );
  if (!cwdResult.ok) {
    return cwdResult;
  }
  const invoke = createInvoke(cwdResult.value, deps.run);
  const changesResult = await resolveScopeChanges(invoke, changeset.scope);
  if (!changesResult.ok) {
    return changesResult;
  }

  // Totals are ALWAYS real computed numbers for a git-scope changeset (never
  // null — see `ChangesetView`'s doc comment): binary numstat columns are
  // null and are EXCLUDED from the sum (never coerced to 0 silently — the
  // entry itself still carries `additions: null`), so a changeset whose
  // files are ALL binary correctly totals `0`/`0`, a real computed zero.
  const files: ChangedFileEntry[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const record of changesResult.value) {
    files.push({
      additions: record.additions,
      deletions: record.deletions,
      ...(record.oldPath === null ? {} : { oldPath: record.oldPath }),
      path: record.path,
      repositoryRoot: changeset.repositoryRoot,
      revertible: false,
      rootId: rootIdResult.value,
      status: record.status,
      worktreePath: cwdResult.value,
    });
    totalAdditions += record.additions ?? 0;
    totalDeletions += record.deletions ?? 0;
  }
  return { ok: true, value: { changeset, files, totalAdditions, totalDeletions } };
}

/** Path-untracked check scoped to ONE path — the `uncommitted`/`unstaged`
 * fileDiff mapping's `working` vs `untracked` decision. Mirrors
 * `git-structured-diff.ts`'s private `isPathUntracked` (not exported; see
 * this module's doc comment on why some helpers are re-derived instead of
 * imported). */
async function isPathUntrackedInScope(
  invoke: InvokeFn,
  pathArg: string
): Promise<BoundaryResult<boolean>> {
  const [statusRun, prefixRun] = await Promise.all([
    invoke(['status', '--porcelain=v2', '--untracked-files=all', '-z', '--', pathArg]),
    invoke(['rev-parse', '--show-prefix']),
  ]);
  if (statusRun.exitCode !== 0) {
    return gitCommandFailed(statusRun);
  }
  if (prefixRun.exitCode !== 0) {
    return gitCommandFailed(prefixRun);
  }
  const scoped = scopeStatusPaths(
    parsePorcelainV2Z(statusRun.stdout),
    stripLineEnding(prefixRun.stdout)
  );
  if (!scoped.ok) {
    return scoped;
  }
  return {
    ok: true,
    value: scoped.value.files.some((file) => file.untracked && file.path === pathArg),
  };
}

/**
 * Map a `git-scope` + path to `StructuredFileDiffParams`. `uncommitted` maps
 * to `working` (or `untracked` for an untracked path) — the engine has no
 * separate "everything, staged or not, since the last commit, plus untracked"
 * mode, so `uncommitted`'s per-file content reuses `working`/`untracked`,
 * matching its own listing (`resolveUncommittedChanges`, tracked-vs-HEAD plus
 * untracked). `unstaged` maps to its OWN `unstaged` engine mode (BST-1113
 * review finding — see `StructuredFileDiffParams`'s `unstaged` doc comment in
 * `@brainstrike/types`): before this mode existed, `unstaged` was mapped to
 * `working` too, which compares HEAD-vs-worktree — a DIFFERENT comparison
 * than `unstaged`'s own index-vs-worktree LISTING
 * (`listRefComparisonChanges(invoke, [])`), so a file with both staged and
 * unstaged edits showed contradictory numbers between the listing and its
 * rendered diff. An untracked path can never appear in the `unstaged` scope's
 * own listing (it has no index entry, so `git diff` with no ref args never
 * reports it), so `unstaged` needs no untracked branch — the engine's own
 * `unstaged` mode already redirects an untracked path to a directing error
 * (mirroring `working`'s posture) rather than silently misreporting it.
 *
 * Exported (in addition to `resolveGitScopeFileDiff`, which calls it) so a
 * unit test can assert on the exact `StructuredFileDiffParams` this resolves
 * to — in particular that `branch-vs-base` receives the MERGE-BASE as
 * `baseRef`, never the raw resolved base ref — without needing to fake the
 * entire downstream `structuredFileDiff` engine invocation sequence.
 */
export async function resolveGitScopeStructuredFileDiffParams(
  invoke: InvokeFn,
  scope: GitScope,
  path_: string
): Promise<BoundaryResult<StructuredFileDiffParams>> {
  switch (scope.kind) {
    case 'uncommitted': {
      const untracked = await isPathUntrackedInScope(invoke, path_);
      if (!untracked.ok) {
        return untracked;
      }
      return {
        ok: true,
        value: untracked.value
          ? { mode: 'untracked', path: path_ }
          : { mode: 'working', path: path_ },
      };
    }
    case 'unstaged':
      return { ok: true, value: { mode: 'unstaged', path: path_ } };
    case 'staged':
      return { ok: true, value: { mode: 'staged', path: path_ } };
    case 'commit': {
      const fullId = await resolveFullCommitId(invoke, scope.commitId);
      if (!fullId.ok) {
        return fullId;
      }
      return { ok: true, value: { commitId: fullId.value, mode: 'commit', path: path_ } };
    }
    case 'branch-vs-base': {
      const refs = await resolveBranchVsBaseRefs(invoke, scope);
      if (!refs.ok) {
        return refs;
      }
      if (refs.value.unborn) {
        // NOT `base-ref-unresolved:` — the base ref itself was never even
        // looked up (`resolveBranchVsBaseRefs` short-circuits on an unborn
        // HEAD before attempting resolution); the real, distinct condition
        // is that there is no HEAD commit to diff against at all.
        return gitRefused(
          'conflict',
          'changeset.head-unborn',
          'cannot resolve a per-file diff for branch-vs-base — this repository has no commits yet.'
        );
      }
      // CRITICAL (3a review finding): `range` mode receives the MERGE-BASE
      // (`refs.value.oldRef`), never the raw resolved base ref — otherwise the
      // per-file diff would silently disagree with the three-dot-equivalent
      // listing `resolveBranchVsBaseRefs` also produced.
      return { ok: true, value: { baseRef: refs.value.oldRef, mode: 'range', path: path_ } };
    }
    default: {
      const exhaustive: never = scope;
      return gitUnexpected(`unsupported git scope: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function resolveGitScopeFileDiff(
  deps: GitScopeDeps,
  rootId: unknown,
  changeset: GitScopeChangeset,
  path_: string
): Promise<BoundaryResult<StructuredFileDiff>> {
  const cwdResult = await resolveContainedWorktreeCwd(
    deps.resolveRootCwd,
    rootId,
    changeset.worktreePath
  );
  if (!cwdResult.ok) {
    return cwdResult;
  }
  const cwd = cwdResult.value;
  const invoke = createInvoke(cwd, deps.run);
  const paramsResult = await resolveGitScopeStructuredFileDiffParams(
    invoke,
    changeset.scope,
    path_
  );
  if (!paramsResult.ok) {
    return paramsResult;
  }
  return await createGitService({ cwd, run: deps.run }).structuredFileDiff(paramsResult.value);
}
