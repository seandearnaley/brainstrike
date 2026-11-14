/**
 * ADR-0034 build decisions (BST-2504): whether a managed worktree's branch has
 * merged into its repository's default branch, so archive on merge may take it.
 *
 * It has merged only when all of these hold:
 * - the worktree is on a branch (not detached) and has no uncommitted changes;
 * - the branch has moved since the worktree was made: its tip is not the commit
 *   the ledger recorded at creation (BST-2518). A worktree never committed to
 *   adds nothing, whatever the default branch took, and is the idle cap's;
 * - the branch has commits of its own: its tip is not on the default branch's
 *   first-parent history. A branch only moved along that history has none, and
 *   neither has one merged by a fast-forward, which the idle cap is left to. A
 *   branch whose history meets that history nowhere (merged in as unrelated
 *   history) is not merged either;
 * - the branch adds nothing the default branch lacks: `git merge-tree
 *   --write-tree <default> <branch>` merges cleanly and writes the default
 *   branch's own tree. That holds for a squash merge as well as an ordinary one.
 *
 * The default branch is the local view of `origin`'s (`default-branch.ts`); the
 * host never fetches. `merge-tree --write-tree` came in Git 2.38, which is newer
 * than the 2.36 the rest of the host needs, so an older git checks nothing.
 * Nor does a repository whose own config names a merge driver: a content merge
 * would run that command, which the host never runs for a folder (BST-2454),
 * and a driver can also make the merge come out as the default branch's tree.
 * Nor does a partial clone (BST-2518): a blob the merge needs may be missing,
 * and git would fetch it from the promisor remote on demand. Git can be told
 * not to (`--no-lazy-fetch`, `GIT_NO_LAZY_FETCH`) only from 2.45, and without
 * the blob the merge cannot be told anyway.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { resolveDefaultBaseRef } from './default-branch.ts';
import { gitCommandFailed, gitRefused, gitUnexpected } from './git-failure.ts';
import { invokeGitHookFree, parseGitVersion, stripLineEnding } from './git-service.ts';
import type { GitInvoke } from './worktree-archive.ts';

/** `git merge-tree --write-tree` came in Git 2.38. */
const MERGE_TREE_GIT = [2, 38] as const;

/** Config files that are the person's own; every other scope came with the repository. */
const PERSON_SCOPES = new Set(['global', 'system']);

/** Why a worktree's branch does not count as merged. */
export type WorktreeNotMergedReason =
  | 'adds-to-default'
  | 'base-commit-unrecorded'
  | 'detached'
  | 'no-commits-of-its-own'
  | 'uncommitted-changes'
  | 'unmoved'
  | 'unrelated-history';

export type WorktreeMergedVerdict =
  | { readonly branch: string; readonly merged: true }
  | { readonly merged: false; readonly reason: WorktreeNotMergedReason };

/** The default branch a repository's worktrees are checked against, e.g. `origin/main`. */
export interface MergeTarget {
  readonly defaultBranch: string;
}

function lines(output: string): string[] {
  return stripLineEnding(output)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Refused when git is older than 2.38, the repository's own config names a merge driver, or the
 * repository is a partial clone.
 */
async function checkMergeTreeRuns(repository: GitInvoke): Promise<BoundaryResult<null>> {
  const version = await checkGitVersion(repository);
  if (!version.ok) {
    return version;
  }
  const driver = await checkNoRepositoryDriver(repository);
  return driver.ok ? await checkNotPartialClone(repository) : driver;
}

async function checkGitVersion(repository: GitInvoke): Promise<BoundaryResult<null>> {
  const versionRun = await repository(['--version']);
  if (versionRun.exitCode !== 0) {
    return gitCommandFailed(versionRun);
  }
  const version = parseGitVersion(stripLineEnding(versionRun.stdout));
  if (!version) {
    return gitUnexpected('git returned an unrecognized version string');
  }
  const [major, minor] = version;
  if (major < MERGE_TREE_GIT[0] || (major === MERGE_TREE_GIT[0] && minor < MERGE_TREE_GIT[1])) {
    return gitRefused(
      'configuration',
      'git.version-unsupported',
      `Git 2.38 or newer is needed to tell whether a worktree's branch has merged; found ${version.join('.')}`
    );
  }
  return { ok: true, value: null };
}

/** Refused when the repository's own config names a merge driver; the person's own may. */
async function checkNoRepositoryDriver(repository: GitInvoke): Promise<BoundaryResult<null>> {
  const driverRun = await repository([
    'config',
    '--null',
    '--show-scope',
    '--get-regexp',
    String.raw`^merge\..*\.driver$`,
  ]);
  // Exit 1 with no output: no merge driver is configured anywhere.
  if (driverRun.exitCode === 1 && driverRun.stdout.length === 0) {
    return { ok: true, value: null };
  }
  if (driverRun.exitCode !== 0) {
    return gitCommandFailed(driverRun);
  }
  // `scope NUL key LF value NUL` per entry.
  const fields = driverRun.stdout.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (!PERSON_SCOPES.has(fields[index] ?? '')) {
      return gitRefused(
        'configuration',
        'worktree.repository-merge-driver',
        "This repository's own git config names a merge driver, which the host does not run to tell whether a branch has merged."
      );
    }
  }
  return { ok: true, value: null };
}

/** Refused when the repository has a promisor remote: it is a partial clone. */
async function checkNotPartialClone(repository: GitInvoke): Promise<BoundaryResult<null>> {
  const partialRun = await repository(['config', '--get', 'extensions.partialClone']);
  const promisorRun = await repository([
    'config',
    '--type=bool',
    '--get-regexp',
    String.raw`^remote\..*\.promisor$`,
  ]);
  for (const run of [partialRun, promisorRun]) {
    // Exit 1 with no output: the key is set nowhere.
    if (run.exitCode !== 0 && !(run.exitCode === 1 && run.stdout.length === 0)) {
      return gitCommandFailed(run);
    }
  }
  // `key true` or `key false` per remote.
  const promisor = lines(promisorRun.stdout).some((line) => line.endsWith(' true'));
  if (partialRun.exitCode === 0 || promisor) {
    return gitRefused(
      'configuration',
      'worktree.partial-clone',
      'This repository is a partial clone: telling whether a branch has merged could fetch from its remote, which the host never does.'
    );
  }
  return { ok: true, value: null };
}

/**
 * The repository's default branch, on a git that can check it: refused when git is older than
 * 2.38, when the repository's own config names a merge driver, or when it has no default branch.
 * `repository` is git in the repository's common dir.
 */
export async function resolveMergeTarget(
  repository: GitInvoke
): Promise<BoundaryResult<MergeTarget>> {
  const runs = await checkMergeTreeRuns(repository);
  if (!runs.ok) {
    return runs;
  }
  const defaultBranch = await resolveDefaultBaseRef(repository);
  return defaultBranch.ok
    ? { ok: true, value: { defaultBranch: defaultBranch.value } }
    : defaultBranch;
}

/** The branch the worktree's HEAD is on, as its full ref; null when detached. */
async function readBranchRef(worktree: GitInvoke): Promise<BoundaryResult<string | null>> {
  const headRun = await worktree(['symbolic-ref', '--quiet', 'HEAD']);
  if (headRun.exitCode === 1) {
    return { ok: true, value: null };
  }
  if (headRun.exitCode !== 0) {
    return gitCommandFailed(headRun);
  }
  const ref = stripLineEnding(headRun.stdout).trim();
  return { ok: true, value: ref.startsWith('refs/heads/') ? ref : null };
}

/** The commit `ref` names; null when it names none. */
async function readCommit(
  repository: GitInvoke,
  ref: string
): Promise<BoundaryResult<string | null>> {
  const commitRun = await repository(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  // Exit 1 with no output: no such commit.
  if (commitRun.exitCode === 1 && commitRun.stdout.length === 0) {
    return { ok: true, value: null };
  }
  if (commitRun.exitCode !== 0) {
    return gitCommandFailed(commitRun);
  }
  const commit = lines(commitRun.stdout)[0];
  return commit === undefined
    ? gitUnexpected('git named no commit for a ref it verified')
    : { ok: true, value: commit };
}

/**
 * Whether the branch has commits of its own: its tip is not on the default branch's first-parent
 * history. A branch only moved along that history (fast-forwarded to it, rebased onto it with
 * nothing left of its own, or reset to an older commit of it) has none. A squash-merged branch's
 * tip is not an ancestor of the default branch, and a merged branch's tip is a merge's second
 * parent, so both have commits of their own. A tip merged in as a second parent whose history
 * the first-parent history never meets is `'unrelated'`.
 */
async function hasCommitsOfItsOwn(
  repository: GitInvoke,
  defaultRef: string,
  tip: string
): Promise<BoundaryResult<boolean | 'unrelated'>> {
  const ancestorRun = await repository(['merge-base', '--is-ancestor', tip, defaultRef]);
  if (ancestorRun.exitCode === 1) {
    return { ok: true, value: true };
  }
  if (ancestorRun.exitCode !== 0) {
    return gitCommandFailed(ancestorRun);
  }
  // The first-parent walk down from the default branch stops at the first commit the tip
  // reaches, so the tip is on that history exactly when it is that many first parents down.
  const depthRun = await repository([
    'rev-list',
    '--first-parent',
    '--count',
    `${tip}..${defaultRef}`,
  ]);
  if (depthRun.exitCode !== 0) {
    return gitCommandFailed(depthRun);
  }
  const depth = lines(depthRun.stdout)[0] ?? '';
  if (!/^\d+$/u.test(depth)) {
    return gitUnexpected('git returned an unrecognized commit count');
  }
  // Past the first-parent root: the walk met none of the tip's history.
  const onHistory = await readCommit(repository, `${defaultRef}~${depth}`);
  if (!onHistory.ok) {
    return onHistory;
  }
  return { ok: true, value: onHistory.value === null ? 'unrelated' : onHistory.value !== tip };
}

/** Whether merging the branch into the default branch writes the default branch's own tree. */
async function addsNothing(
  repository: GitInvoke,
  defaultRef: string,
  tip: string
): Promise<BoundaryResult<boolean>> {
  const mergeRun = await repository(['merge-tree', '--write-tree', defaultRef, tip]);
  // Exit 1: the merge conflicts, so the branch changes what the default branch has.
  if (mergeRun.exitCode === 1) {
    return { ok: true, value: false };
  }
  if (mergeRun.exitCode !== 0) {
    return gitCommandFailed(mergeRun);
  }
  const treeRun = await repository(['rev-parse', '--verify', '--quiet', `${defaultRef}^{tree}`]);
  if (treeRun.exitCode !== 0) {
    return gitCommandFailed(treeRun);
  }
  const merged = lines(mergeRun.stdout)[0];
  return { ok: true, value: merged !== undefined && merged === lines(treeRun.stdout)[0] };
}

/**
 * Whether the worktree's branch counts as merged into `target`: it has moved from `baseCommit`,
 * the commit the ledger recorded as the worktree's at its creation, has commits of its own and
 * adds nothing `target` lacks. A row with no recorded commit (one from before state DB version 19)
 * is never merged. `repository` is git in the repository's common dir; `worktree` is git in the
 * worktree's folder.
 */
export async function readWorktreeMerged(input: {
  readonly baseCommit: string | null;
  readonly repository: GitInvoke;
  readonly target: MergeTarget;
  readonly worktree: GitInvoke;
}): Promise<BoundaryResult<WorktreeMergedVerdict>> {
  const notMerged = (reason: WorktreeNotMergedReason) =>
    ({ ok: true, value: { merged: false, reason } }) as const;
  if (input.baseCommit === null) {
    return notMerged('base-commit-unrecorded');
  }
  const branchRef = await readBranchRef(input.worktree);
  if (!branchRef.ok) {
    return branchRef;
  }
  if (branchRef.value === null) {
    return notMerged('detached');
  }
  const tip = await readCommit(input.repository, branchRef.value);
  if (!tip.ok) {
    return tip;
  }
  // An unborn branch (`checkout --orphan`) has no commit yet, so none of its own.
  if (tip.value === null) {
    return notMerged('no-commits-of-its-own');
  }
  if (tip.value === input.baseCommit) {
    return notMerged('unmoved');
  }
  const defaultRef = `refs/remotes/${input.target.defaultBranch}`;
  const own = await hasCommitsOfItsOwn(input.repository, defaultRef, tip.value);
  if (!own.ok) {
    return own;
  }
  if (own.value === 'unrelated') {
    return notMerged('unrelated-history');
  }
  if (!own.value) {
    return notMerged('no-commits-of-its-own');
  }
  const statusRun = await invokeGitHookFree(input.worktree, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ]);
  if (statusRun.exitCode !== 0) {
    return gitCommandFailed(statusRun);
  }
  if (statusRun.stdout.length > 0) {
    return notMerged('uncommitted-changes');
  }
  const adds = await addsNothing(input.repository, defaultRef, tip.value);
  if (!adds.ok) {
    return adds;
  }
  return adds.value
    ? { ok: true, value: { branch: branchRef.value.slice('refs/heads/'.length), merged: true } }
    : notMerged('adds-to-default');
}
