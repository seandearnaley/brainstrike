/**
 * `git-scope`-sourced `ChangesetView`/`fileDiff` resolution (BST-1113) — split
 * out of `changeset-diff-service.ts` to keep that file under its line-count
 * budget. See that module's doc comment for the overall dispatch.
 *
 * `git-service.ts` and `git-structured-diff.ts` MUST NOT GROW (both are at
 * their line-count ceiling), so this module invokes `git` DIRECTLY via its own
 * thin `InvokeFn` closure over the injected raw `GitCommandRunner` for
 * operations `createGitService` does not expose as an op (numstat/raw
 * listing, `merge-base`, `rev-parse`, `symbolic-ref`) — reusing every existing
 * EXPORTED helper (`describeFailure`, `stripLineEnding`, `parsePorcelainV2Z`,
 * `scopeStatusPaths`, `resolveContainedPathArg`, `assertUntrackedDiffPathContained`)
 * rather than re-deriving them. Only `structuredFileDiff` itself goes through
 * `createGitService({ cwd, run })`, per the plan's explicit instruction to
 * reuse the W1 engine for per-file content.
 */

import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createConcurrencyLimiter } from '@brainstrike/effect-kit';
import type {
  ChangedFileEntry,
  ChangedFileStatus,
  ChangesAction,
  Changeset,
  ChangesetView,
  GitScope,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';
import {
  describeFailure,
  gitCommandFailed,
  gitInvalid,
  gitRefused,
  gitUnexpected,
} from './git-failure.ts';
import {
  createGitService,
  diffFailure,
  GIT_DEFAULT_TIMEOUT_MS,
  type GitCommandRun,
  type GitCommandRunner,
  parsePorcelainV2Z,
  scopeStatusPaths,
  stripLineEnding,
} from './git-service.ts';
import {
  resolveCommitOldRef,
  resolveEmptyTreeHash,
  validateBaseRef,
  validateCommitId,
} from './git-structured-diff-refs.ts';
import {
  boundViewPatches,
  completePatch,
  diffGitHeader,
  fileRevision,
  type PatchCapture,
  pinnedDiffArgs,
  pinnedPatchArgs,
  pinnedStatusArgs,
  splitPatchByFile,
} from './structured-diff-content.ts';
import { parseNumstatZ, parseRawZ } from './structured-diff-parsers.ts';

export type GitScopeChangeset = Extract<Changeset, { kind: 'git-scope' }>;

type InvokeFn = (args: readonly string[], timeoutMs?: number) => Promise<GitCommandRun>;

/**
 * The actions a git scope offers its files (ADR-0036): the working tree
 * stages or discards, the index unstages. Committed history is never
 * rewritten.
 */
const SCOPE_ACTIONS: Readonly<Record<GitScope['kind'], readonly ChangesAction[]>> = {
  'branch-vs-base': [],
  commit: [],
  staged: ['unstage'],
  uncommitted: [],
  unstaged: ['stage', 'revert'],
};

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
 *
 * The folder's own git then says where its work tree is, since git reads
 * and writes there: a repository inside the root can name a work tree
 * outside it (`core.worktree`). The folder must be inside that work tree,
 * and the work tree's top inside the root, or the view and every write are
 * refused.
 */
export async function resolveContainedWorktreeCwd(
  deps: GitScopeDeps,
  rootId: unknown,
  worktreePath: string
): Promise<BoundaryResult<string>> {
  const rootCwd = await deps.resolveRootCwd(rootId);
  if (!rootCwd.ok) {
    return rootCwd;
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
  const workTreeRun = await deps.run({
    args: ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
    cwd: worktreeReal,
    timeoutMs: GIT_DEFAULT_TIMEOUT_MS,
  });
  if (workTreeRun.exitCode !== 0) {
    return gitCommandFailed(workTreeRun);
  }
  const [inside, top = ''] = workTreeRun.stdout.split(/\r?\n/u);
  const topReal = inside === 'true' ? await realpath(top).catch(() => null) : null;
  if (topReal === null || !isPathContained(rootCwd.value, topReal)) {
    return gitRefused(
      'authorization',
      'changeset.outside-roots',
      `the git work tree of "${worktreePath}" is not inside the resolved workspace root.`
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
  /** Git's blob ids for both sides, from `--raw`; none for an untracked file. */
  readonly blobs: readonly string[];
  readonly deletions: number | null;
  /** A submodule or embedded repository, mode 160000 on either side. */
  readonly gitlink: boolean;
  readonly oldPath: string | null;
  /** The file's whole patch, before the view's budget (`boundViewPatches`). */
  readonly patch: string | null;
  /** True when git's patch for the file (a binary's included) names its content. */
  readonly patchNamesContent: boolean;
  readonly path: string;
  /** {@link fileRevision} of the file as listed. */
  readonly revision: string;
  readonly status: ChangedFileStatus;
}

type ListedChange = Omit<ScopeChangeRecord, 'patch' | 'patchNamesContent' | 'revision'>;

/**
 * An untracked file's counts and patch, read through its own per-file diff,
 * since numstat never sees an untracked file. Null when the read failed; the
 * file then loads its diff when opened.
 */
type UntrackedDiffReader = (
  path: string
) => Promise<Pick<ScopeChangeRecord, 'additions' | 'deletions' | 'patch'> | null>;

/** Untracked files diffed at once: each is its own `git diff --no-index`. */
const UNTRACKED_DIFF_CONCURRENCY = 8;

/**
 * Untracked files the view diffs up front, in path order. Each costs a git
 * process, so a tree of thousands of unignored files stays one `git status`;
 * the files past this count load their diff when opened.
 */
const UNTRACKED_VIEW_DIFFS = 100;

/**
 * Give each listed file its section of the scope's patch, matched by the
 * `diff --git` line git writes for its paths, never by position. A text file
 * with no section, or a section no listed file claims, is a visible error. A
 * binary file has no patch to draw, but its section names both sides' blobs,
 * so its revision covers its content. A cut capture leaves the files past
 * the cut without one; they load their diff on demand.
 */
function attachPatches(
  records: readonly ListedChange[],
  capture: PatchCapture
): BoundaryResult<readonly ScopeChangeRecord[]> {
  const sections = splitPatchByFile(capture);
  const unclaimed = new Set(sections.keys());
  const withPatches: ScopeChangeRecord[] = [];
  for (const record of records) {
    const header = diffGitHeader(record.oldPath ?? record.path, record.path);
    const section = sections.get(header);
    unclaimed.delete(header);
    if (section === undefined && record.additions !== null && !capture.truncated) {
      return gitUnexpected(`git diff returned no patch for "${record.path}"`);
    }
    withPatches.push({
      ...record,
      patch: record.additions === null ? null : (section ?? null),
      patchNamesContent: section !== undefined,
      revision: fileRevision({ ...record, identity: record.blobs, patch: section ?? null }),
    });
  }
  const [stray] = unclaimed;
  if (stray !== undefined) {
    return gitUnexpected(`git diff returned a patch no listed file claims: "${stray}"`);
  }
  return { ok: true, value: withPatches };
}

/** The mode of a gitlink: a submodule's or an embedded repository's commit. */
const GITLINK_MODE = '160000';

/**
 * `git diff --raw` single-char status codes → {@link ChangedFileStatus}
 * (R3, review finding): git legitimately emits `A/C/D/M/R/T/U/X/B`, not just
 * `A/D/M/R` — an unmapped code previously failed the ENTIRE scope listing
 * (verified against a real repo: a symlink↔regular-file swap, status `T`,
 * made `uncommitted` / `staged` / `unstaged` / `commit` unusable for the
 * WHOLE changeset, not just that one file). Settled mapping:
 * - `T` (typechange, e.g. symlink↔regular file) → `'modified'`: both sides
 *   exist and their content differs — an honest fit, no new status needed.
 * - `C` (copy — only possible with an explicit `--find-copies`/`-C` flag,
 *   which this module never passes, so `C` should not occur today; mapped
 *   defensively anyway) → `'added'`: a copy's destination is a NEW path.
 * - `U` (unmerged) is NOT in this map — handled as a hard, dedicated
 *   `changeset.unmerged-path` refusal in {@link listRefComparisonChanges},
 *   matching W1's unmerged-surfacing posture in `git-structured-diff.ts`
 *   (`CAT_FILE_UNMERGED_STDERR_PATTERN`): a conflicted path has a real,
 *   structured reason it can't be diffed, and silently reporting it as any
 *   other status would be misleading, not just imprecise.
 * - `X`/`B` (git-internal "unknown"/"broken pairing" — not expected in
 *   practice) fall through to the generic "unsupported file status" error
 *   below, scoped to the ONE offending path.
 */
const RAW_STATUS_TO_CHANGED_STATUS: ReadonlyMap<string, ChangedFileStatus> = new Map([
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
 * `--numstat` (counts + rename pairs) and `--raw` (status classification,
 * see {@link RAW_STATUS_TO_CHANGED_STATUS}, and both sides' modes) — merged
 * by final path, plus the patch every file draws ({@link attachPatches}).
 * Two listing calls are needed because `--numstat` alone carries no
 * add/delete/modify classification.
 *
 * The merge is checked in BOTH directions: every numstat entry must have a
 * matching raw entry, AND every raw entry must have a matching numstat
 * entry. Checking only one direction would silently drop whichever side's
 * extra entries went unchecked — the two invocations run
 * against the SAME target and flags, so in the absence of a genuine git bug
 * their path sets must be identical; a mismatch in EITHER direction is
 * reported as a visible error, never silently ignored.
 */
async function listRefComparisonChanges(
  invoke: InvokeFn,
  target: readonly string[]
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  const [numstatRun, rawRun, patchRun] = await Promise.all([
    invoke(pinnedDiffArgs([...target, '--numstat', '-z', '--relative', '--find-renames'])),
    invoke(
      pinnedDiffArgs([...target, '--raw', '-z', '--no-abbrev', '--relative', '--find-renames'])
    ),
    invoke(pinnedPatchArgs([...target, '--relative', '--find-renames'])),
  ]);
  if (numstatRun.exitCode !== 0) {
    return gitCommandFailed(numstatRun);
  }
  if (rawRun.exitCode !== 0) {
    return gitCommandFailed(rawRun);
  }
  const patchFailure = diffFailure(patchRun, false);
  if (patchFailure) {
    return patchFailure;
  }
  const numstatEntries = parseNumstatZ(numstatRun.stdout);
  const rawEntries = parseRawZ(rawRun.stdout);
  // Index against worktree, git lists a conflicted path twice, `U` then `M`,
  // and writes its patch as a combined `diff --cc`; against the index alone
  // it lists `U` only. Either way the conflict is named, never misreported.
  const unmerged = rawEntries.find((entry) => entry.status === 'U');
  if (unmerged) {
    return gitRefused(
      'conflict',
      'changeset.unmerged-path',
      `"${unmerged.path}" has unresolved merge conflicts — resolve them before viewing this scope's diff.`
    );
  }
  const statusByPath = new Map(rawEntries.map((entry) => [entry.path, entry]));
  const numstatPaths = new Set(numstatEntries.map((entry) => entry.path));

  for (const statusEntry of rawEntries) {
    if (!numstatPaths.has(statusEntry.path)) {
      return gitUnexpected(
        `git --raw reported "${statusEntry.path}" with no matching numstat entry`
      );
    }
  }

  const records: ListedChange[] = [];
  for (const numstatEntry of numstatEntries) {
    const statusEntry = statusByPath.get(numstatEntry.path);
    if (!statusEntry) {
      return gitUnexpected(
        `git numstat reported "${numstatEntry.path}" with no matching --raw entry`
      );
    }
    const mappedStatus = RAW_STATUS_TO_CHANGED_STATUS.get(statusEntry.status);
    if (!mappedStatus) {
      return gitUnexpected(
        `git reported an unsupported file status "${statusEntry.status}" for "${numstatEntry.path}"`
      );
    }
    records.push({
      additions: numstatEntry.additions,
      blobs: [statusEntry.oldId, statusEntry.newId],
      deletions: numstatEntry.deletions,
      gitlink: statusEntry.oldMode === GITLINK_MODE || statusEntry.newMode === GITLINK_MODE,
      oldPath: mappedStatus === 'renamed' ? numstatEntry.oldPath : null,
      path: numstatEntry.path,
      status: mappedStatus,
    });
  }
  return attachPatches(records, {
    text: patchRun.stdout,
    truncated: patchRun.failureReason === 'maxBuffer',
  });
}

/** Untracked files, for the `uncommitted` and `unstaged` scopes (an untracked
 * file is a working-tree change the index does not hold, as VS Code's and
 * Codex's Unstaged lists show it); `staged` never includes them. Numstat
 * has no concept of an untracked file (`git diff` never diffs one), so
 * `additions`/`deletions` are honestly `null` here, matching the binary
 * convention — never a fabricated count from reading the file. Each file's
 * patch comes from its own per-file diff, so the two never differ. */
async function listUntrackedChanges(
  invoke: InvokeFn,
  readDiff: UntrackedDiffReader
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  const [statusRun, prefixRun] = await Promise.all([
    invoke(pinnedStatusArgs('.')),
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
  const limit = createConcurrencyLimiter(UNTRACKED_DIFF_CONCURRENCY);
  const records = await Promise.all(
    scoped.value.files
      .filter((file) => file.untracked)
      .map(async (file, index) => {
        const diff = index < UNTRACKED_VIEW_DIFFS ? await limit(() => readDiff(file.path)) : null;
        const listed = {
          additions: diff?.additions ?? null,
          blobs: [],
          deletions: diff?.deletions ?? null,
          gitlink: false,
          oldPath: null,
          patch: diff?.patch ?? null,
          patchNamesContent: (diff?.patch ?? null) !== null,
          path: file.path,
          status: 'untracked' as const,
        };
        return { ...listed, revision: fileRevision(listed) };
      })
  );
  return { ok: true, value: records };
}

/**
 * A working-tree file's stat as git's index keeps it: size, times, inode and
 * mode. A file that is gone reads `absent`.
 */
async function worktreeStamp(cwd: string, file: string): Promise<string> {
  try {
    const stats = await lstat(path.join(cwd, file), { bigint: true });
    return [stats.size, stats.mtimeNs, stats.ctimeNs, stats.ino, stats.mode].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }
    throw error;
  }
}

/**
 * A working-tree file no patch names the content of (an untracked binary, or
 * a file past the view's limits) also names its stat, so newer content there
 * reads differently even where git's listing would not.
 */
async function stampUndrawn(
  cwd: string,
  records: readonly ScopeChangeRecord[]
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  try {
    const stamped = await Promise.all(
      records.map(async (record) =>
        record.patchNamesContent
          ? record
          : {
              ...record,
              revision: fileRevision({
                ...record,
                identity: [record.revision, await worktreeStamp(cwd, record.path)],
              }),
            }
      )
    );
    return { ok: true, value: stamped };
  } catch (error) {
    return gitUnexpected(`could not read a changed file's stat: ${String(error)}`);
  }
}

/** A working-tree scope: the tracked changes against `oldTarget`, then the untracked files. */
async function listWorkingTreeChanges(
  invoke: InvokeFn,
  oldTarget: readonly string[],
  readDiff: UntrackedDiffReader
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  const tracked = await listRefComparisonChanges(invoke, oldTarget);
  if (!tracked.ok) {
    return tracked;
  }
  const untracked = await listUntrackedChanges(invoke, readDiff);
  if (!untracked.ok) {
    return untracked;
  }
  return { ok: true, value: [...tracked.value, ...untracked.value] };
}

async function resolveUncommittedChanges(
  invoke: InvokeFn,
  readDiff: UntrackedDiffReader
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  if (!(await isHeadUnborn(invoke))) {
    return await listWorkingTreeChanges(invoke, ['HEAD'], readDiff);
  }
  const emptyTree = await resolveEmptyTreeHash(invoke);
  if (!emptyTree.ok) {
    return emptyTree;
  }
  return await listWorkingTreeChanges(invoke, [emptyTree.value], readDiff);
}

/** Scope → change listing dispatch. See this module's doc comment for why
 * numstat/raw are invoked directly rather than through
 * `createGitService`, which has no listing op. */
async function resolveScopeChanges(
  invoke: InvokeFn,
  scope: GitScope,
  readDiff: UntrackedDiffReader
): Promise<BoundaryResult<readonly ScopeChangeRecord[]>> {
  switch (scope.kind) {
    case 'uncommitted':
      return await resolveUncommittedChanges(invoke, readDiff);
    case 'unstaged':
      return await listWorkingTreeChanges(invoke, [], readDiff);
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
  readonly resolveRootCwd: (rootId: unknown) => Promise<BoundaryResult<string>>;
  readonly run: GitCommandRunner;
}

/**
 * What one file offers (ADR-0036): its scope's actions, less what git cannot
 * do to it. Git lists an untracked repository as its folder, and staging it
 * records an embedded repository with no `.gitmodules`; `git restore` leaves
 * a gitlink's checkout where it is, so a gitlink does not revert.
 */
function fileActions(scope: GitScope, record: ScopeChangeRecord): readonly ChangesAction[] {
  if (record.status === 'untracked' && record.path.endsWith('/')) {
    return [];
  }
  const actions = SCOPE_ACTIONS[scope.kind];
  return record.gitlink ? actions.filter((action) => action !== 'revert') : actions;
}

/**
 * Resolve a `git-scope` changeset's `ChangesetView`. Totals are summed from
 * numstat; a binary file's null additions/deletions are EXCLUDED from the sum
 * (never coerced to 0 — the entry itself still appears with `additions: null`).
 * Each entry carries what it offers ({@link fileActions}), its revision, and
 * its patch within the view's budget (`boundViewPatches`).
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
    deps,
    rootIdResult.value,
    changeset.worktreePath
  );
  if (!cwdResult.ok) {
    return cwdResult;
  }
  const invoke = createInvoke(cwdResult.value, deps.run);
  const listed = await resolveScopeChanges(
    invoke,
    changeset.scope,
    untrackedDiffReader(cwdResult.value, deps.run)
  );
  if (!listed.ok) {
    return listed;
  }
  const changesResult =
    changeset.scope.kind === 'unstaged' || changeset.scope.kind === 'uncommitted'
      ? await stampUndrawn(cwdResult.value, listed.value)
      : listed;
  if (!changesResult.ok) {
    return changesResult;
  }

  // Totals are ALWAYS real computed numbers for a git-scope changeset (never
  // null — see `ChangesetView`'s doc comment): binary numstat columns, and
  // untracked files the view did not diff, are null and are EXCLUDED from the sum (never coerced to 0 silently — the
  // entry itself still carries `additions: null`), so a changeset whose
  // files are ALL binary correctly totals `0`/`0`, a real computed zero.
  const files: ChangedFileEntry[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const record of changesResult.value) {
    files.push({
      actions: fileActions(changeset.scope, record),
      additions: record.additions,
      deletions: record.deletions,
      ...(record.oldPath === null ? {} : { oldPath: record.oldPath }),
      patch: record.patch,
      path: record.path,
      repositoryRoot: changeset.repositoryRoot,
      revision: record.revision,
      rootId: rootIdResult.value,
      status: record.status,
      worktreePath: cwdResult.value,
    });
    totalAdditions += record.additions ?? 0;
    totalDeletions += record.deletions ?? 0;
  }
  return {
    ok: true,
    value: { changeset, files: boundViewPatches(files), totalAdditions, totalDeletions },
  };
}

/**
 * An untracked file's counts and patch through the engine's own `untracked`
 * mode, so the view and the file's diff share one code path. A file that
 * cannot be read here (it vanished, or resolves outside the folder) gets
 * null; opening its diff reports why.
 */
function untrackedDiffReader(cwd: string, run: GitCommandRunner): UntrackedDiffReader {
  const service = createGitService({ cwd, run });
  return async (path_) => {
    const diff = await service.structuredFileDiff({ mode: 'untracked', path: path_ });
    return diff.ok
      ? {
          additions: diff.value.additions,
          deletions: diff.value.deletions,
          patch: completePatch(diff.value.content),
        }
      : null;
  };
}

/** Path-untracked check scoped to ONE path — the `uncommitted`/`unstaged`
 * fileDiff mapping's tracked vs `untracked` decision. Mirrors
 * `git-structured-diff.ts`'s private `isPathUntracked` (not exported; see
 * this module's doc comment on why some helpers are re-derived instead of
 * imported). */
async function isPathUntrackedInScope(
  invoke: InvokeFn,
  pathArg: string
): Promise<BoundaryResult<boolean>> {
  const [statusRun, prefixRun] = await Promise.all([
    invoke(pinnedStatusArgs(pathArg)),
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
 * Map a `git-scope` + path to `StructuredFileDiffParams`. The two working-tree
 * scopes list untracked files too, so an untracked path maps to `untracked`
 * in both. Otherwise `uncommitted` maps to `working` — the engine has no
 * separate "everything, staged or not, since the last commit" mode, so its
 * per-file content reuses `working`, matching its own listing (tracked
 * against HEAD). `unstaged` maps to its OWN `unstaged` engine mode (BST-1113
 * review finding — see `StructuredFileDiffParams`'s `unstaged` doc comment in
 * `@brainstrike/types`): `working` compares HEAD-vs-worktree — a DIFFERENT
 * comparison than `unstaged`'s own index-vs-worktree LISTING, so a file with
 * both staged and unstaged edits would show contradictory numbers between
 * the listing and its rendered diff.
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
    case 'uncommitted':
    case 'unstaged': {
      const untracked = await isPathUntrackedInScope(invoke, path_);
      if (!untracked.ok) {
        return untracked;
      }
      if (untracked.value) {
        return { ok: true, value: { mode: 'untracked', path: path_ } };
      }
      return {
        ok: true,
        value: { mode: scope.kind === 'unstaged' ? 'unstaged' : 'working', path: path_ },
      };
    }
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
  const cwdResult = await resolveContainedWorktreeCwd(deps, rootId, changeset.worktreePath);
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
