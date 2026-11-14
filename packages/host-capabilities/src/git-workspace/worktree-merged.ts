/**
 * ADR-0034 build decisions (BST-2504): whether a managed worktree's branch has
 * merged into its repository's default branch, so archive on merge may take it.
 *
 * It has merged only when all of these hold:
 * - the worktree is on a branch (not detached) and has no uncommitted changes;
 * - the branch has commits of its own: its tip is not on the default branch's
 *   first-parent history. A branch only moved along that history has none, and
 *   neither has one merged by a fast-forward, which the idle cap is left to;
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
  | 'detached'
  | 'no-commits-of-its-own'
  | 'uncommitted-changes';

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

/** Refused when git is older than 2.38 or the repository's own config names a merge driver. */
async function checkMergeTreeRuns(repository: GitInvoke): Promise<BoundaryResult<null>> {
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

/**
 * Whether the branch has commits of its own: its tip is not on the default branch's first-parent
 * history. A branch only moved along that history (fast-forwarded to it, rebased onto it with
 * nothing left of its own, or reset to an older commit of it) has none. A squash-merged branch's
 * tip is not an ancestor of the default branch, and a merged branch's tip is a merge's second
 * parent, so both have commits of their own.
 */
async function hasCommitsOfItsOwn(
  repository: GitInvoke,
  defaultRef: string,
  branchRef: string
): Promise<BoundaryResult<boolean>> {
  const ancestorRun = await repository(['merge-base', '--is-ancestor', branchRef, defaultRef]);
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
    `${branchRef}..${defaultRef}`,
  ]);
  if (depthRun.exitCode !== 0) {
    return gitCommandFailed(depthRun);
  }
  const depth = lines(depthRun.stdout)[0] ?? '';
  if (!/^\d+$/u.test(depth)) {
    return gitUnexpected('git returned an unrecognized commit count');
  }
  const commitsRun = await repository([
    'rev-parse',
    `${defaultRef}~${depth}^{commit}`,
    `${branchRef}^{commit}`,
  ]);
  if (commitsRun.exitCode !== 0) {
    return gitCommandFailed(commitsRun);
  }
  const [onHistory, tip] = lines(commitsRun.stdout);
  return { ok: true, value: onHistory !== tip };
}

/** Whether merging the branch into the default branch writes the default branch's own tree. */
async function addsNothing(
  repository: GitInvoke,
  defaultRef: string,
  branchRef: string
): Promise<BoundaryResult<boolean>> {
  const mergeRun = await repository(['merge-tree', '--write-tree', defaultRef, branchRef]);
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
 * Whether the worktree's branch counts as merged into `target`: it has commits of its own and
 * adds nothing `target` lacks. `repository` is git in the
 * repository's common dir; `worktree` is git in the worktree's folder.
 */
export async function readWorktreeMerged(input: {
  readonly repository: GitInvoke;
  readonly target: MergeTarget;
  readonly worktree: GitInvoke;
}): Promise<BoundaryResult<WorktreeMergedVerdict>> {
  const notMerged = (reason: WorktreeNotMergedReason) =>
    ({ ok: true, value: { merged: false, reason } }) as const;
  const branchRef = await readBranchRef(input.worktree);
  if (!branchRef.ok) {
    return branchRef;
  }
  if (branchRef.value === null) {
    return notMerged('detached');
  }
  const defaultRef = `refs/remotes/${input.target.defaultBranch}`;
  const own = await hasCommitsOfItsOwn(input.repository, defaultRef, branchRef.value);
  if (!own.ok) {
    return own;
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
  const adds = await addsNothing(input.repository, defaultRef, branchRef.value);
  if (!adds.ok) {
    return adds;
  }
  return adds.value
    ? { ok: true, value: { branch: branchRef.value.slice('refs/heads/'.length), merged: true } }
    : notMerged('adds-to-default');
}
