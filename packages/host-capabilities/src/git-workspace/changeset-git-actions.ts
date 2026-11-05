/**
 * Stage, unstage and revert in a git scope (ADR-0036). The host is the only
 * writer, and git does the writing: path-level commands for whole files, and
 * `git apply` of git's own current patch, cut to the chosen hunks, for hunks.
 *
 * Before anything is written the scope is listed again through the code path
 * its view used, so a target the view no longer holds, or a file that reads
 * differently than the view drew it, is refused, never guessed at. A file's
 * hunks come from that listing's patch, or, when the listing carries none,
 * from the file's own diff. Each file takes only the actions its entry
 * offers. `git apply` is all-or-nothing: a patch that no longer applies
 * changes nothing.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import {
  actionHunks,
  type ChangedFileEntry,
  type ChangesAction,
  type ChangesActionTarget,
  type ChangesApplyResult,
  type ChangesetView,
  type ChangesFileRevision,
} from '@brainstrike/types';
import {
  type GitScopeChangeset,
  type GitScopeDeps,
  resolveContainedWorktreeCwd,
  resolveGitScopeChangesetView,
  resolveGitScopeFileDiff,
} from './changeset-git-scope.ts';
import {
  describeFailure,
  gitCommandFailed,
  gitFault,
  gitRefused,
  gitUnexpected,
  refuseStale,
  refuseUnoffered,
} from './git-failure.ts';
import {
  GIT_DEFAULT_TIMEOUT_MS,
  type GitCommandRun,
  readGitHookFreeFlags,
  stripLineEnding,
} from './git-service.ts';

export interface GitScopeApply {
  readonly action: ChangesAction;
  readonly changeset: GitScopeChangeset;
  readonly rootId: string;
  readonly target: ChangesActionTarget;
}

/** One git command of an action; `input` goes to its stdin. */
interface GitWrite {
  readonly args: readonly string[];
  /** Set for `git apply`, whose refusal (exit 1) names the file it could not patch. */
  readonly hunksOf?: string;
  readonly input?: string;
}

interface WritePlan {
  readonly paths: readonly string[];
  readonly writes: readonly GitWrite[];
}

type Invoke = (args: readonly string[], input?: string) => Promise<GitCommandRun>;

/** NUL-separated pathspecs on stdin: no command-line limit, and literal under the runner's pins. */
const PATHSPECS_FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

/**
 * Characters of paths per `git clean`, which takes no pathspec file: Windows
 * caps a whole command line at 32,767.
 */
const CLEAN_PATHS_BUDGET = 24_000;

/** `git apply` per action: the index forwards or back, or the working tree back. */
const APPLY_MODE: Readonly<Record<ChangesAction, readonly string[]>> = {
  revert: ['-R'],
  stage: ['--cached'],
  unstage: ['--cached', '-R'],
};

/**
 * The listing's entry for a target file: refused as stale once the listing
 * no longer holds it, or, given the `revision` the view drew, once it reads
 * differently; refused when the file does not offer `action`.
 */
function offeredEntry(
  listed: ReadonlyMap<string, ChangedFileEntry>,
  action: ChangesAction,
  filePath: string,
  revision: string | null
): BoundaryResult<ChangedFileEntry> {
  const entry = listed.get(filePath);
  if (!entry) {
    return refuseStale(`"${filePath}" is no longer in this view.`);
  }
  if (revision !== null && entry.revision !== revision) {
    return refuseStale(`"${filePath}" changed since this view was drawn.`);
  }
  if (!entry.actions.includes(action)) {
    return refuseUnoffered(`"${filePath}" does not offer ${action}.`);
  }
  return { ok: true, value: entry };
}

function byPath(view: ChangesetView): ReadonlyMap<string, ChangedFileEntry> {
  return new Map(view.files.map((file) => [file.path, file]));
}

/** Each entry's path, and a rename's old path before it. */
function bothSides(entries: readonly ChangedFileEntry[]): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]
      )
    ),
  ];
}

function cleanChunks(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let size = Number.POSITIVE_INFINITY;
  for (const filePath of paths) {
    // Each path also costs its quotes and a space.
    if (size + filePath.length + 3 > CLEAN_PATHS_BUDGET) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)?.push(filePath);
    size += filePath.length + 3;
  }
  return chunks;
}

function fromStdin(args: readonly string[], paths: readonly string[]): GitWrite[] {
  return paths.length > 0
    ? [{ args: [...args, ...PATHSPECS_FROM_STDIN], input: paths.join('\0') }]
    : [];
}

/**
 * Discard each file back to the index, by the status the listing gives it.
 * A tracked file is restored from the index. A file the index holds only as
 * an intent to add (`git add -N`), listed added or as a rename's new side,
 * is removed with its intent, as an untracked file is: restoring it would
 * leave it empty. Only a file the listing names untracked is deleted.
 */
function revertWrites(entries: readonly ChangedFileEntry[]): GitWrite[] {
  const restored: string[] = [];
  const intended: string[] = [];
  const untracked: string[] = [];
  for (const entry of entries) {
    if (entry.status === 'untracked') {
      untracked.push(entry.path);
      continue;
    }
    if (entry.oldPath !== undefined) {
      restored.push(entry.oldPath);
    }
    (entry.status === 'added' || entry.status === 'renamed' ? intended : restored).push(entry.path);
  }
  return [
    ...fromStdin(['restore', '--worktree'], restored),
    ...fromStdin(['rm', '--force', '--quiet'], intended),
    ...cleanChunks(untracked).map((chunk) => ({ args: ['clean', '-f', '-q', '--', ...chunk] })),
  ];
}

/**
 * Whole files as the view drew them: the index takes or gives back both
 * sides of a rename, and revert discards each file by its status
 * ({@link revertWrites}).
 */
function planFiles(
  view: ChangesetView,
  action: ChangesAction,
  files: readonly ChangesFileRevision[]
): BoundaryResult<WritePlan> {
  const listed = byPath(view);
  const entries: ChangedFileEntry[] = [];
  for (const file of files) {
    const entry = offeredEntry(listed, action, file.path, file.revision);
    if (!entry.ok) {
      return entry;
    }
    entries.push(entry.value);
  }
  const changed = bothSides(entries);
  if (action === 'revert') {
    return { ok: true, value: { paths: changed, writes: revertWrites(entries) } };
  }
  const args = action === 'stage' ? ['add', '--all'] : ['reset', '-q'];
  return { ok: true, value: { paths: changed, writes: fromStdin(args, changed) } };
}

/** The file's header for a patch of some of its hunks; a mode change is not a hunk's. */
function hunkPatchHeader(patch: string): string {
  const header: string[] = [];
  for (const line of patch.split(/(?<=\n)/u)) {
    if (line.startsWith('@@ ')) {
      break;
    }
    if (!(line.startsWith('old mode ') || line.startsWith('new mode '))) {
      header.push(line);
    }
  }
  return header.join('');
}

/** A hunk's `@@` line: each side's start line, then `,count` unless the count is 1. */
const HUNK_RANGE = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/u;

const lineCount = (count: string) => (count === '' ? 1 : Number(count.slice(1)));

/**
 * The chosen hunks, numbered for a patch that leaves the others out, as
 * git's own `add -p` numbers them (add-patch.c, `render_hunk`). `git apply`
 * looks for a hunk first at the start line of the side it patches, and git
 * numbered that side as if every earlier hunk applied; where text repeats, a
 * start that counts a hunk left out finds the wrong copy. Each hunk left out
 * before a chosen one moves it by its old count less its new count: the new
 * start forward, the old start reversed (`-R`). Null for a `@@` line git
 * would not write.
 */
function renumberChosen(
  hunks: readonly string[],
  wanted: ReadonlySet<string>,
  reverse: boolean
): string[] | null {
  let delta = 0;
  const chosen: string[] = [];
  for (const hunk of hunks) {
    const range = HUNK_RANGE.exec(hunk);
    if (!range) {
      return null;
    }
    const [header = '', oldStart = '', oldCount = '', newStart = '', newCount = ''] = range;
    if (!wanted.has(hunk)) {
      delta += lineCount(oldCount) - lineCount(newCount);
      continue;
    }
    const oldAt = reverse ? Number(oldStart) - delta : Number(oldStart);
    const newAt = reverse ? Number(newStart) : Number(newStart) + delta;
    chosen.push(`@@ -${oldAt}${oldCount} +${newAt}${newCount} @@${hunk.slice(header.length)}`);
  }
  return chosen;
}

/**
 * Git's current patch for a listed file: the listing's, or, for a file whose
 * patch the view left out, its own diff's. Null for a binary file.
 */
async function currentPatch(
  deps: GitScopeDeps,
  { changeset, rootId }: GitScopeApply,
  entry: ChangedFileEntry
): Promise<BoundaryResult<string | null>> {
  if (entry.patch !== null) {
    return { ok: true, value: entry.patch };
  }
  const diff = await resolveGitScopeFileDiff(deps, rootId, changeset, entry.path);
  if (!diff.ok) {
    return diff;
  }
  const { content } = diff.value;
  return { ok: true, value: content.kind === 'binary' ? null : content.patch };
}

/**
 * Some of one modified file's hunks: the file's current patch keeps its
 * header and the chosen hunks in their order. Only the hunks
 * {@link actionHunks} splits the patch into are offered, and a hunk whose
 * text is not one of them is refused as stale; git is sent the chosen hunks
 * renumbered ({@link renumberChosen}). The view's patch paths are relative
 * to the scope's folder, so `--directory` puts them back under it when the
 * folder is inside the repository.
 */
async function planHunks(
  deps: GitScopeDeps,
  request: GitScopeApply,
  target: Extract<ChangesActionTarget, { kind: 'hunks' }>,
  view: ChangesetView,
  invoke: Invoke
): Promise<BoundaryResult<WritePlan>> {
  const { action } = request;
  const filePath = target.path;
  const entry = offeredEntry(byPath(view), action, filePath, null);
  if (!entry.ok) {
    return entry;
  }
  if (entry.value.status !== 'modified') {
    return refuseUnoffered(`"${filePath}" is ${entry.value.status}; ${action} the whole file.`);
  }
  const patch = await currentPatch(deps, request, entry.value);
  if (!patch.ok) {
    return patch;
  }
  if (patch.value === null) {
    return refuseUnoffered(`"${filePath}" is binary; ${action} the whole file.`);
  }
  const hunks = actionHunks(patch.value);
  if (hunks === null) {
    return refuseUnoffered(`"${filePath}" takes no hunks one at a time; ${action} the whole file.`);
  }
  const wanted = new Set(target.hunks);
  if (hunks.filter((hunk) => wanted.has(hunk)).length !== wanted.size) {
    return refuseStale(`"${filePath}" changed since this view was drawn.`);
  }
  const chosen = renumberChosen(hunks, wanted, APPLY_MODE[action].includes('-R'));
  if (chosen === null) {
    return gitUnexpected(`git's patch for "${filePath}" has a hunk line git does not write`);
  }
  const prefixRun = await invoke(['rev-parse', '--show-prefix']);
  if (prefixRun.exitCode !== 0) {
    return gitCommandFailed(prefixRun);
  }
  const prefix = stripLineEnding(prefixRun.stdout);
  const args = [
    // The user's config must not change what applies, or where.
    '-c',
    'apply.ignoreWhitespace=no',
    'apply',
    '--whitespace=nowarn',
    ...APPLY_MODE[action],
    ...(prefix.length > 0 ? [`--directory=${prefix}`] : []),
    '-',
  ];
  const input = `${hunkPatchHeader(patch.value)}${chosen.join('')}`;
  return { ok: true, value: { paths: [filePath], writes: [{ args, hunksOf: filePath, input }] } };
}

/** Runs the plan's commands in order, hook-free, and stops at the first that fails. */
async function runPlan(
  invoke: Invoke,
  action: ChangesAction,
  plan: WritePlan
): Promise<BoundaryResult<ChangesApplyResult>> {
  const hookFree = await readGitHookFreeFlags((args) => invoke(args));
  if (!hookFree.ok) {
    return gitCommandFailed(hookFree.run);
  }
  for (const [index, write] of plan.writes.entries()) {
    const run = await invoke([...hookFree.flags, ...write.args], write.input);
    if (run.exitCode === 0) {
      continue;
    }
    if (write.hunksOf !== undefined && run.exitCode === 1) {
      return gitRefused(
        'conflict',
        'changeset.apply-conflict',
        `git could not apply the hunks to "${write.hunksOf}": ${describeFailure(run)}`
      );
    }
    return index === 0
      ? gitCommandFailed(run)
      : gitFault(
          'changeset.apply-partial',
          `Only part of the ${action} applied: ${describeFailure(run)}`
        );
  }
  return { ok: true, value: { paths: plan.paths } };
}

export async function applyGitScopeAction(
  deps: GitScopeDeps,
  request: GitScopeApply
): Promise<BoundaryResult<ChangesApplyResult>> {
  const { action, changeset, rootId, target } = request;
  const cwd = await resolveContainedWorktreeCwd(deps, rootId, changeset.worktreePath);
  if (!cwd.ok) {
    return cwd;
  }
  const view = await resolveGitScopeChangesetView(deps, rootId, changeset);
  if (!view.ok) {
    return view;
  }
  const invoke: Invoke = (args, input) =>
    deps.run({ args, cwd: cwd.value, input, timeoutMs: GIT_DEFAULT_TIMEOUT_MS });
  const plan =
    target.kind === 'files'
      ? planFiles(view.value, action, target.files)
      : await planHunks(deps, request, target, view.value, invoke);
  if (!plan.ok) {
    return plan;
  }
  return await runPlan(invoke, action, plan.value);
}
