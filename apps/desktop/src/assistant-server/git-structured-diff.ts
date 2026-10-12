/**
 * Structured (both-sides + hunk-range) file diff ops for the desktop `git`
 * IPC domain — the `StructuredFileDiff` engine split out of `git-service.ts`
 * (BST-1111, BST-1118) to keep that file under the line-count ratchet.
 *
 * Like `git-service.ts`, this module has NO Electron imports so it is
 * hermetically testable: `createStructuredDiffOps` takes the already-pinned
 * `cwd` plus the SAME injected `invoke`/`invokeHookFree` runners the caller
 * (`createGitService`) builds around its `execFile`-style `GitCommandRunner`.
 * There is no `exec`/`spawn shell:true` anywhere in this file, and every git
 * failure resolves into a structured `{ ok: false, error }` result rather than
 * throwing across the IPC boundary.
 *
 * The caller (`createGitService`, or ultimately the IPC handler) remains
 * responsible for resolving + containment-checking `cwd` against a known
 * workspace root before any of this runs.
 *
 * PATH SPACE: `cwd` may be a SUBDIRECTORY of the git worktree (a workspace
 * root opened partway into a larger repo), not necessarily the worktree root.
 * Every `pathArg` this module receives (via `resolveContainedPathArg`) is
 * CWD-relative. git's own output is REPO-ROOT-relative by default for
 * `--numstat`/unified-diff invocations and for `cat-file <rev>:<path>` specs
 * — empirically confirmed against real git 2.54 (`git diff HEAD --numstat -z`
 * from a subdirectory reports `sub/dir/file.txt`, not `file.txt`; `git
 * cat-file blob HEAD:file.txt` from that same subdirectory resolves against
 * the REPO ROOT and fails with "does not exist in 'HEAD'" for a file that
 * plainly exists at `sub/dir/file.txt`). Left unhandled, every tracked diff
 * from a sub-root cwd would report "no differences", `isPathUntracked` would
 * never fire, and `cat-file` specs would point at the wrong object entirely.
 * Fixed coherently to CWD-relative everywhere:
 * - `--relative` on the numstat and unified-diff invocations (git's own flag
 *   for cwd-relative path DISPLAY; pathspecs passed via `--` were always
 *   cwd-relative already — this only affects git's OUTPUT).
 * - The `:./<path>` magic pathspec form for `cat-file` specs (`HEAD:./f.txt`,
 *   `:0:./f.txt`) — empirically confirmed this resolves against cwd, unlike
 *   the bare `HEAD:f.txt` form which resolves against the repo root.
 * - `isPathUntracked` strips the `git rev-parse --show-prefix` value from
 *   `git status`'s (always repo-root-relative, no `--relative` flag exists
 *   for `status`) reported paths before comparing — the exact
 *   `scopeStatusPaths` precedent `git-service.ts`'s `status()` method already
 *   uses for the same reason.
 *
 * MODES `commit`/`range` (BST-1113): two more comparisons past the original
 * `working`/`staged`/`untracked` trio, both comparing two REFS rather than a
 * ref against the worktree/index — `commit` diffs `<commitId>^` vs
 * `<commitId>`; `range` diffs a caller-resolved `baseRef` vs HEAD (see
 * {@link StructuredFileDiffParams}'s doc comment in `@brainstrike/types` for
 * why the new side is HEAD, not the worktree). Both sides are read via the
 * SAME `readRefBlob`/`./` magic-pathspec machinery as `staged` mode's old
 * side — no new path-space convention. Ref-injection safety validation and
 * the root-commit empty-tree fallback live in the sibling
 * `git-structured-diff-refs.ts` module (kept separate to hold this file
 * under its line-count ratchet); the unified-diff / numstat / cap / binary
 * assembly machinery below is GENERALIZED (not duplicated) to accept an
 * arbitrary diff target — `['--cached']`, `['HEAD']`, or an explicit
 * `[oldRef, newRef]` pair — so `commit`/`range` reuse the exact same
 * size-probe-before-read, `hunks-only` degradation, and binary-detection
 * code paths `staged`/`working` already exercise.
 *
 * MODE `unstaged` (BST-1113 review finding): the INDEX vs the worktree —
 * `:0:./<path>` (old) vs the live file (new) — added so a file's per-file
 * diff always agrees with the `unstaged` git-scope's own LISTING
 * (`changeset-git-scope.ts`'s `listRefComparisonChanges(invoke, [])`, i.e.
 * `git diff` with no ref args). Before this mode existed, `unstaged`'s
 * per-file diff was mapped to `working` (HEAD vs worktree) — a DIFFERENT
 * comparison than its listing, so a file with both staged and unstaged
 * edits reported contradictory numbers between the list and the rendered
 * diff. Reuses the exact same `readTrackedSides`/`assembleDiffContent`
 * machinery as `staged`/`working`, just with its own old-side spec and `[]`
 * numstat/diff target.
 */
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChangedFileStatus,
  GitResult,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';
import {
  assertUntrackedDiffPathContained,
  boundOutput,
  describeDiffFailure,
  describeFailure,
  GIT_DEFAULT_TIMEOUT_MS,
  type GitCommandRun,
  parsePorcelainV2Z,
  resolveContainedPathArg,
  scopeStatusPaths,
  stripLineEnding,
  toErrorMessage,
} from './git-service';
import { resolveCommitOldRef, validateBaseRef, validateCommitId } from './git-structured-diff-refs';
import {
  countLines,
  type NumstatEntry,
  parseHunkHeaders,
  parseNumstatZ,
} from './structured-diff-parsers';

/**
 * Per-side full-content cap for {@link StructuredFileDiff}: a side (old or new)
 * larger than this degrades that file's `content` to `hunks-only` instead of
 * inlining full text (spec §11 Q3). Deliberately kept in NOMINAL parity with the
 * file-mutation tools' per-file write cap (`MAX_WRITE_WORKSPACE_FILE_BYTES`
 * in `file-mutation-tools.ts`, `2_000_000` bytes) — both exist so a single file
 * can't blow main-process memory on a read that has to hold full before/after
 * text. The two constants are NOT byte-identical today (`2 * 1024 * 1024` here
 * vs `2_000_000` there); this is the structured-diff engine's own cap, but the
 * two should move together if either is revisited.
 */
export const STRUCTURED_DIFF_CONTENT_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Exit-128 stderr wording `git cat-file` (`-s` size probe OR `blob` read —
 * empirically confirmed IDENTICAL wording for both) uses for an ABSENT object
 * spec, confirmed against real git 2.54 in a scratch repo (never guessed):
 * - `HEAD:<path>` never existed at HEAD → "does not exist in 'HEAD'"
 * - `HEAD:<path>` before the first commit (unborn HEAD) → "invalid object name 'HEAD'."
 * - `:0:<path>` with no index entry at all → "does not exist (neither on disk nor in the index)"
 * - `:0:<path>` present on disk but not staged (e.g. `git rm --cached`) →
 *   "exists on disk, but not in the index"
 * ANY other exit-128 stderr (a real read error, OR the unmerged wording below)
 * must NOT match this and falls through to `ok: false` — this is the spike's
 * exact absent-vs-error bug.
 */
const CAT_FILE_ABSENT_STDERR_PATTERN =
  /does not exist|exists on disk, but not in|invalid object name/;

/**
 * Exit-128 stderr wording for a path that IS in the index but has no stage-0
 * entry — i.e. an UNRESOLVED MERGE CONFLICT (`:0:<path>` only; `HEAD:<path>`
 * has no concept of "stages"). Empirically confirmed: "fatal: path 'x' is in
 * the index, but not at stage 0". Deliberately NOT part of the absent
 * pattern — a conflicted path has a real, structured reason it can't be read,
 * and reporting it as "deleted" would be actively misleading (the file is
 * neither deleted nor addable; it needs conflict resolution).
 */
const CAT_FILE_UNMERGED_STDERR_PATTERN = /is in the index, but not at stage/;

/**
 * Classify a failed (non-zero exit) `cat-file` invocation — `-s` size probe
 * OR `blob` read share the exact same stderr vocabulary for a missing
 * object, so both call this. An unmerged stage-0 miss is a hard, explicit
 * `ok: false` (never silently reported as an absent/deleted side — see
 * {@link CAT_FILE_UNMERGED_STDERR_PATTERN}); an absent object is an honest
 * `ok: true` "absent"; anything else is a real error.
 */
function classifyCatFileFailure(run: GitCommandRun, pathArg: string): GitResult<'absent'> {
  if (run.exitCode === 128) {
    if (CAT_FILE_UNMERGED_STDERR_PATTERN.test(run.stderr)) {
      return {
        error: `unmerged path '${pathArg}' — resolve merge conflicts to view the staged diff`,
        ok: false,
      };
    }
    if (CAT_FILE_ABSENT_STDERR_PATTERN.test(run.stderr)) {
      return { ok: true, value: 'absent' };
    }
  }
  return { error: describeFailure(run), ok: false };
}

/**
 * One side's read outcome for a structured diff, size-gated BEFORE any
 * content is read (never just "trust a size read afterward"):
 * - `absent`: the side doesn't exist (added/deleted/untracked-missing).
 * - `over-cap`: the side exists and its size is known, but content was
 *   deliberately NOT read (it exceeds {@link STRUCTURED_DIFF_CONTENT_CAP_BYTES}).
 *   Binary detection is therefore impossible for an over-cap side — see
 *   `assembleTrackedContent`'s ordering.
 * - `present`: the side was read in full; `content` is the exact bytes.
 */
type SideRead =
  | { readonly content: Buffer; readonly kind: 'present' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'over-cap'; readonly size: number };

/** Pure status classification for a tracked-mode structured diff entry. */
function classifyTrackedStatus(
  isRename: boolean,
  oldSide: SideRead,
  newSide: SideRead
): ChangedFileStatus {
  if (isRename) {
    return 'renamed';
  }
  if (oldSide.kind === 'absent') {
    return 'added';
  }
  return newSide.kind === 'absent' ? 'deleted' : 'modified';
}

/** Pure `hunks-only` reason classification from the two per-side cap checks. */
function classifyOverCapReason(
  oldOverCap: boolean,
  newOverCap: boolean
): 'over-cap-both' | 'over-cap-new' | 'over-cap-old' {
  if (oldOverCap && newOverCap) {
    return 'over-cap-both';
  }
  return oldOverCap ? 'over-cap-old' : 'over-cap-new';
}

/**
 * `hunks-only` reason when the unified diff invocation itself hit `maxBuffer`.
 * Called only when at least one of {oldOverCap, newOverCap, a maxBuffer
 * overflow} is true (see the caller's guard) — when NEITHER side is
 * individually over the per-file cap, the maxBuffer overflow is the only
 * possible reason we were called at all, so this reports the honest
 * `'diff-overflow'` reason rather than guessing at a side. When a side IS
 * individually over cap, that's the more precise, existing reason.
 */
function resolveOverCapReason(
  oldOverCap: boolean,
  newOverCap: boolean
): 'diff-overflow' | 'over-cap-both' | 'over-cap-new' | 'over-cap-old' {
  if (oldOverCap || newOverCap) {
    return classifyOverCapReason(oldOverCap, newOverCap);
  }
  return 'diff-overflow';
}

/**
 * Validate {@link StructuredFileDiffParams}: unlike `validateDiffParams` in
 * `git-service.ts`, `path` is required in EVERY mode. `commitId` (mode
 * `commit`) and `baseRef` (mode `range`) get additional ref-injection-safety
 * validation from `git-structured-diff-refs.ts` — see that module's doc
 * comment — and are REJECTED as unsupported keys on every other mode
 * (including each other's), never silently ignored.
 */
function validateStructuredFileDiffParams(
  params: StructuredFileDiffParams
): GitResult<StructuredFileDiffParams> {
  if (!(params && typeof params === 'object') || Array.isArray(params)) {
    return {
      error: 'structured diff params must be an object with an explicit mode',
      ok: false,
    };
  }
  const record = params as unknown as Record<string, unknown>;
  const mode = record['mode'];
  if (
    mode !== 'working' &&
    mode !== 'staged' &&
    mode !== 'unstaged' &&
    mode !== 'untracked' &&
    mode !== 'commit' &&
    mode !== 'range'
  ) {
    return {
      error:
        'structured diff mode must be "working", "staged", "unstaged", "untracked", "commit", or "range"',
      ok: false,
    };
  }
  const allowedKeys = new Set([
    'mode',
    'path',
    ...(mode === 'commit' ? ['commitId'] : []),
    ...(mode === 'range' ? ['baseRef'] : []),
  ]);
  const unsupportedKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    return {
      error: `structured diff mode "${mode}" does not accept: ${unsupportedKeys.join(', ')}`,
      ok: false,
    };
  }
  if (typeof record['path'] !== 'string' || record['path'].length === 0) {
    return { error: 'structured diff requires a non-empty path', ok: false };
  }
  if (mode === 'commit') {
    const commitIdResult = validateCommitId(record['commitId']);
    if (!commitIdResult.ok) {
      return commitIdResult;
    }
  }
  if (mode === 'range') {
    const baseRefResult = validateBaseRef(record['baseRef']);
    if (!baseRefResult.ok) {
      return baseRefResult;
    }
  }
  return { ok: true, value: params };
}

/**
 * Unified diff for exactly ONE file's structured hunks / hunks-only content
 * — always a plain two-way `git diff` (HEAD, the index, or `/dev/null`),
 * never `--cc`/merge output, satisfying {@link parseHunkHeaders}'s
 * single-file, two-way precondition by construction. `untracked` mode uses
 * this ONLY for the oversized-content preview ({@link structuredUntrackedDiff}
 * never populates `hunks` from it, since an untracked file has no
 * meaningful "hunk ranges" — it's a whole-file addition).
 *
 * For a rename BOTH `oldPath` and `pathArg` are passed as pathspecs. This is
 * NOT optional: gitdiffcore(7) documents that pathspec limiting happens
 * BEFORE rename pairing ("the commands themselves first ... limit the two
 * sets of files by any pathspecs ... and compare corresponding paths in the
 * two resulting sets"), so a pathspec naming only the new path can never pair
 * with its old name — empirically confirmed: `git diff --cached --numstat -z
 * --find-renames -- new.txt` on a real staged rename reports `5\t0\tnew.txt`
 * (a plain add), not the `1\t1\t\0old.txt\0new.txt` rename triple that the
 * SAME command WITHOUT a path restriction (or with both paths) produces.
 *
 * `--relative` is added for the ref-comparing branch so the diff headers
 * (and the pathspecs, which were already cwd-relative) agree — see the
 * module doc comment's PATH SPACE section. `--no-index` has no repo-root
 * concept, so the `untracked` branch needs no such flag.
 */
interface UnifiedDiffRun {
  readonly text: string;
  /** True when `text` is a possibly-malformed PARTIAL capture (the diff
   * invocation itself hit `maxBuffer`) — never feed this to `parseHunkHeaders`
   * as though it were the complete diff; see the callers below. */
  readonly truncated: boolean;
}

/** Both read sides of a tracked-mode diff, plus the status/oldPath they
 * already determine — the shared handoff between `readTrackedSides`
 * and `assembleTrackedContent`. */
interface TrackedSides {
  readonly newSide: SideRead;
  readonly oldPathField: { oldPath?: string };
  readonly oldSide: SideRead;
  readonly status: ChangedFileStatus;
}

/**
 * Structural type for the git-command runner this module closes over —
 * matches `createGitService`'s internal `invoke` helper in `git-service.ts`
 * exactly (default `timeoutMs`, optional `binaryStdout`).
 */
type InvokeFn = (
  args: readonly string[],
  timeoutMs?: number,
  binaryStdout?: boolean
) => Promise<GitCommandRun>;

/**
 * Structural type for `createGitService`'s internal `invokeHookFree` helper —
 * same runner, hooks disabled at command scope before mutating invocations.
 */
type InvokeHookFreeFn = (args: readonly string[], timeoutMs?: number) => Promise<GitCommandRun>;

export interface StructuredDiffOpsOptions {
  readonly cwd: string;
  readonly invoke: InvokeFn;
  readonly invokeHookFree: InvokeHookFreeFn;
}

/**
 * Build the `structuredFileDiff` op bound to a single, already-validated
 * `cwd` and the caller's `invoke`/`invokeHookFree` runners. Mirrors
 * `createGitService`'s contract: every method returns a `GitResult`, a git
 * failure becomes `{ ok: false, error }`, never a throw.
 */
export function createStructuredDiffOps({ cwd, invoke, invokeHookFree }: StructuredDiffOpsOptions) {
  /**
   * Read one ref-addressed blob (`HEAD:./<path>` or `:0:./<path>` — the
   * `./` magic pathspec form so the spec resolves against `cwd`, not the
   * repo root; see the module doc comment) via `cat-file`, classifying the
   * result into present / absent / over-cap / unmerged / hard-error.
   *
   * Size-PROBES first (`cat-file -s`) so an over-cap side is NEVER actually
   * read — closing both the 2–4MB "dead window" (where the old code would
   * read the full blob into memory even though it was going to be discarded
   * as `hunks-only` anyway) and the >4MB hard-fail (where the old code would
   * hit `maxBuffer` and report a confusing error for a file this engine was
   * always going to degrade gracefully). A `maxBuffer` overflow during the
   * ACTUAL blob read (size known-safe, then something changes) stays a hard,
   * unexpected failure — unlike a diff, a blob has no self-describing
   * boundary a caller could use to detect a silent truncation (see
   * `GitCommandRun.stdoutBuffer`).
   */
  async function readRefBlob(spec: string, pathArg: string): Promise<GitResult<SideRead>> {
    const sizeRun = await invoke(['cat-file', '-s', spec]);
    if (sizeRun.exitCode !== 0) {
      const classified = classifyCatFileFailure(sizeRun, pathArg);
      if (!classified.ok) {
        return classified;
      }
      return { ok: true, value: { kind: 'absent' } };
    }
    const size = Number.parseInt(sizeRun.stdout.trim(), 10);
    if (!Number.isFinite(size)) {
      return { error: `git returned a non-numeric size for "${spec}"`, ok: false };
    }
    if (size > STRUCTURED_DIFF_CONTENT_CAP_BYTES) {
      return { ok: true, value: { kind: 'over-cap', size } };
    }

    const run_ = await invoke(['cat-file', 'blob', spec], GIT_DEFAULT_TIMEOUT_MS, true);
    if (run_.failureReason === 'maxBuffer') {
      return { error: `reading "${spec}" exceeded the output buffer limit`, ok: false };
    }
    if (run_.exitCode === 0) {
      // A clean exit with `binaryStdout: true` MUST carry `stdoutBuffer` per
      // the `GitCommandRunner` contract (see its doc comment) — an absent
      // buffer here means the runner violated that contract, not that the
      // blob is empty. Never fabricate an empty blob for a contract breach.
      if (run_.stdoutBuffer === undefined) {
        return { error: `runner returned no buffer for "${spec}"`, ok: false };
      }
      return { ok: true, value: { content: run_.stdoutBuffer, kind: 'present' } };
    }
    const classified = classifyCatFileFailure(run_, pathArg);
    if (!classified.ok) {
      return classified;
    }
    // Absent between the size probe and the read (a rare race — e.g. a
    // concurrent git operation removed/replaced the object) — still an
    // honest absent side, not an error.
    return { ok: true, value: { kind: 'absent' } };
  }

  /**
   * Read the working-tree side of a structured diff. Reuses
   * `assertUntrackedDiffPathContained`'s parent-realpath containment rule
   * (the same symlinked-ancestor escape it guards against applies here too —
   * this also reads the filesystem directly). ENOENT ⇒ absent (deleted since
   * the last diffed side); any other errno is a real failure.
   *
   * SECURITY: `assertUntrackedDiffPathContained` deliberately does NOT
   * dereference the leaf component — it allows a leaf symlink because git
   * itself only `lstat`s the final path component, so a leaf symlink can never
   * leak the TARGET's content through git. `fs.readFile` has no such property:
   * it OPENS through a symlink, so reading straight through the containment
   * check would (a) leak out-of-root content for an untracked symlink pointing
   * outside the opened root, and (b) for a TRACKED symlink, read the
   * dereferenced target's bytes as the "new" side while `readRefBlob`'s
   * `cat-file blob` naturally returns the raw 120000 blob (the link TEXT) as
   * the "old" side — an inconsistent diff between two different notions of
   * "content" for the same path. Fix: `lstat` first; a symlink's CONTENT for
   * this diff is its link text (the target path string), matching exactly what
   * git itself renders for a 120000 entry — never a dereferenced read.
   *
   * SIZE GUARD: for a regular file, this opens the path ONCE and `fstat`s the
   * resulting file descriptor (not a fresh path-based `stat`) so the SAME fd
   * backs both the size check and the read — no separate
   * check-size-then-`readFile` TOCTOU window where the file could grow past
   * the cap (or otherwise change) between the two. There remains a narrower
   * window between the `lstat` above and this `open` where the path could in
   * principle be swapped for a symlink; closing that fully needs
   * `O_NOFOLLOW`, which Node does not support on Windows — this service
   * already treats symlink handling as POSIX-only (see the `skipIf(win32)`
   * symlink integration tests), so a platform-inconsistent protection would
   * be a false sense of security rather than a real one.
   */
  async function readWorktreeFile(pathArg: string): Promise<GitResult<SideRead>> {
    const containment = await assertUntrackedDiffPathContained(cwd, pathArg);
    if (!containment.ok) {
      return containment;
    }
    const resolved = path.resolve(cwd, pathArg);
    try {
      const lstats = await lstat(resolved);
      if (lstats.isSymbolicLink()) {
        const target = await readlink(resolved);
        return { ok: true, value: { content: Buffer.from(target, 'utf8'), kind: 'present' } };
      }
      const handle = await open(resolved, 'r');
      try {
        const stats = await handle.stat();
        if (stats.size > STRUCTURED_DIFF_CONTENT_CAP_BYTES) {
          return { ok: true, value: { kind: 'over-cap', size: stats.size } };
        }
        const buffer = await handle.readFile();
        return { ok: true, value: { content: buffer, kind: 'present' } };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, value: { kind: 'absent' } };
      }
      return { error: toErrorMessage(error), ok: false };
    }
  }

  /**
   * True when `pathArg` (cwd-relative) shows as untracked in status.
   *
   * `git status` has no `--relative` flag (confirmed: `--relative` is
   * REJECTED by `git status` — "error: unknown option `relative'" — unlike
   * `diff`), so reported paths stay repo-root-relative regardless. Strip the
   * `rev-parse --show-prefix` value from them before comparing to `pathArg`,
   * the exact `scopeStatusPaths` precedent `git-service.ts`'s `status()`
   * method already uses. The pathspec passed via `-- pathArg` is unaffected —
   * pathspecs are always resolved relative to cwd already, independent of
   * how the OUTPUT paths are displayed.
   */
  async function isPathUntracked(pathArg: string): Promise<GitResult<boolean>> {
    const [statusRun, prefixRun] = await Promise.all([
      invoke(['status', '--porcelain=v2', '--untracked-files=all', '-z', '--', pathArg]),
      invoke(['rev-parse', '--show-prefix']),
    ]);
    if (statusRun.exitCode !== 0) {
      return { error: describeFailure(statusRun), ok: false };
    }
    if (prefixRun.exitCode !== 0) {
      return { error: describeFailure(prefixRun), ok: false };
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
   * `target` selects WHAT is being compared: `'untracked'` for the
   * no-HEAD/no-index `--no-index` form, or an explicit `diff` target-args
   * array otherwise — `['--cached']` (staged), `['HEAD']` (working), or an
   * arbitrary `[oldRef, newRef]` pair (`commit`/`range`, BST-1113). This is
   * a plain arg-array rather than a mode enum specifically so `commit`/
   * `range` need no new branch here at all — they're just another target.
   */
  async function computeUnifiedDiff(
    target: readonly string[] | 'untracked',
    pathArg: string,
    oldPath: string | null
  ): Promise<GitResult<UnifiedDiffRun>> {
    const untracked = target === 'untracked';
    const args = untracked
      ? ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', pathArg]
      : [
          'diff',
          ...target,
          '--no-ext-diff',
          '--no-textconv',
          '--find-renames',
          '--relative',
          '--',
          ...(oldPath !== null && oldPath !== pathArg ? [oldPath, pathArg] : [pathArg]),
        ];
    const run_ = await (untracked ? invoke : invokeHookFree)(args);
    const failure = describeDiffFailure(run_, untracked);
    if (failure) {
      return { error: failure, ok: false };
    }
    return {
      ok: true,
      value: { text: run_.stdout, truncated: run_.failureReason === 'maxBuffer' },
    };
  }

  /**
   * Resolve the `working`/`staged` numstat entry for `pathArg`.
   *
   * Deliberately scoped to the opened root (`-- .`), NOT `-- <pathArg>` — see
   * {@link computeUnifiedDiff}'s doc comment: a single-path pathspec here would
   * silence rename detection for exactly the record we need it for. `--relative`
   * makes the reported paths cwd-relative (see the module doc comment's PATH
   * SPACE section) so `entries.find` below can match `pathArg` directly. The
   * numstat text output (paths + counts, no content) stays bounded by the same
   * `GIT_MAX_OUTPUT_BYTES`/`GIT_MAX_BUFFER_BYTES` ceiling as every other git
   * invocation in `git-service.ts`.
   */
  /** `target` is the same `diff` target-args convention {@link computeUnifiedDiff}
   * uses (minus the `'untracked'` case, which has no numstat concept —
   * untracked mode never calls this). Split out so `commit`/`range` reuse it
   * via {@link resolveRefNumstatEntry} instead of duplicating the numstat
   * invocation + parse. */
  async function runNumstat(
    target: readonly string[],
    pathArg: string
  ): Promise<GitResult<NumstatEntry | null>> {
    const numstatRun = await invoke([
      'diff',
      ...target,
      '--numstat',
      '-z',
      '--find-renames',
      '--relative',
      '--',
      '.',
    ]);
    if (numstatRun.exitCode !== 0) {
      return { error: describeFailure(numstatRun), ok: false };
    }
    const entries = parseNumstatZ(numstatRun.stdout);
    return { ok: true, value: entries.find((candidate) => candidate.path === pathArg) ?? null };
  }

  /** `unstaged`'s target is `[]` — the SAME index-vs-worktree comparison as
   * `changeset-git-scope.ts`'s `unstaged` scope LISTING
   * (`listRefComparisonChanges(invoke, [])`), so a file's listed
   * additions/deletions and this per-file diff can never disagree. */
  function trackedNumstatTarget(mode: 'staged' | 'unstaged' | 'working'): readonly string[] {
    if (mode === 'staged') {
      return ['--cached'];
    }
    return mode === 'unstaged' ? [] : ['HEAD'];
  }

  async function resolveNumstatEntry(
    mode: 'staged' | 'unstaged' | 'working',
    pathArg: string
  ): Promise<GitResult<NumstatEntry | null>> {
    return await runNumstat(trackedNumstatTarget(mode), pathArg);
  }

  /** `commit`/`range` numstat entry — same shape as {@link resolveNumstatEntry}
   * but comparing two explicit refs instead of HEAD-vs-index/worktree. */
  async function resolveRefNumstatEntry(
    oldRef: string,
    newRef: string,
    pathArg: string
  ): Promise<GitResult<NumstatEntry | null>> {
    return await runNumstat([oldRef, newRef], pathArg);
  }

  /** Structured diff for the `untracked` mode: no HEAD/index side, whole-file addition. */
  async function structuredUntrackedDiff(pathArg: string): Promise<GitResult<StructuredFileDiff>> {
    const worktreeRead = await readWorktreeFile(pathArg);
    if (!worktreeRead.ok) {
      return worktreeRead;
    }
    const side = worktreeRead.value;
    if (side.kind === 'absent') {
      return { error: `no differences for '${pathArg}' in untracked scope`, ok: false };
    }
    if (side.kind === 'over-cap') {
      // Per the stat-size guard above, an over-cap file's bytes are NEVER
      // read — so neither a null-byte (binary) check nor a line count is
      // possible without reading. `additions` is honestly `null` (the type
      // allows it) rather than a fabricated count. Still show a bounded
      // preview via `git diff --no-index`, which reads the file itself,
      // independent of — and unbounded by — our own gated read above.
      const unifiedDiff = await computeUnifiedDiff('untracked', pathArg, null);
      if (!unifiedDiff.ok) {
        return unifiedDiff;
      }
      const bounded = boundOutput(unifiedDiff.value.text);
      return {
        ok: true,
        value: {
          additions: null,
          content: {
            hunkText: bounded.text,
            hunkTextTruncated: bounded.truncated || unifiedDiff.value.truncated,
            kind: 'hunks-only',
            reason: 'over-cap-new',
          },
          deletions: 0,
          hunks: [],
          path: pathArg,
          status: 'untracked',
        },
      };
    }
    const content = side.content;
    if (content.includes(0)) {
      return {
        ok: true,
        value: {
          additions: null,
          content: { kind: 'binary' },
          deletions: null,
          hunks: [],
          path: pathArg,
          status: 'untracked',
        },
      };
    }
    const text = content.toString('utf8');
    return {
      ok: true,
      value: {
        additions: countLines(text),
        content: { kind: 'full', newContent: text, oldContent: null },
        deletions: 0,
        hunks: [],
        path: pathArg,
        status: 'untracked',
      },
    };
  }

  /**
   * Resolve the numstat entry for `pathArg`, or the correctly-directed error
   * when there isn't one — split out of {@link structuredTrackedDiff} to keep
   * that function's cognitive complexity down.
   */
  async function resolveTrackedEntryForPath(
    mode: 'staged' | 'unstaged' | 'working',
    pathArg: string
  ): Promise<GitResult<NumstatEntry>> {
    const entryResult = await resolveNumstatEntry(mode, pathArg);
    if (!entryResult.ok) {
      return entryResult;
    }
    if (entryResult.value) {
      return { ok: true, value: entryResult.value };
    }
    // An untracked file has no index entry, so it can never produce a
    // numstat entry against EITHER comparison — `working` (HEAD vs
    // worktree) or `unstaged` (index vs worktree) — redirect both the same
    // way. `staged` has no such case: the index IS the old side there.
    if (mode === 'working' || mode === 'unstaged') {
      const untrackedCheck = await isPathUntracked(pathArg);
      if (!untrackedCheck.ok) {
        return untrackedCheck;
      }
      if (untrackedCheck.value) {
        return {
          error: `path "${pathArg}" is untracked; use mode "untracked" instead`,
          ok: false,
        };
      }
    }
    return { error: `no differences for '${pathArg}' in ${mode} scope`, ok: false };
  }

  /** Read both sides of a two-sided diff and classify status — split out to
   * keep {@link structuredTrackedDiff}'s cognitive complexity under the
   * limit. Shared by `staged`/`working` (via {@link readTrackedSides}) AND
   * `commit`/`range` (via `structuredRefDiff`, which supplies its own
   * `oldSpec`/`newSideReader`) — the OLD side is always a `readRefBlob` spec
   * (`HEAD:./<path>` for tracked modes, `<oldRef>:./<path>` for ref-pair
   * modes; the `./` magic pathspec form so the spec resolves against `cwd`
   * — see the module doc comment's PATH SPACE section); the NEW side is
   * whatever the caller's `newSideReader` resolves (index, worktree, or
   * another `readRefBlob` spec). `pathArg` is threaded through for the
   * unmerged-path message even though the OLD side's spec may read
   * `oldPath` for a rename. */
  async function readDiffSides(
    oldSpec: string,
    pathArg: string,
    newSideReader: () => Promise<GitResult<SideRead>>,
    oldPath: string | null
  ): Promise<GitResult<TrackedSides>> {
    const oldRead = await readRefBlob(oldSpec, pathArg);
    if (!oldRead.ok) {
      return oldRead;
    }
    const newRead = await newSideReader();
    if (!newRead.ok) {
      return newRead;
    }
    const oldSide = oldRead.value;
    const newSide = newRead.value;
    return {
      ok: true,
      value: {
        newSide,
        oldPathField: oldPath === null ? {} : { oldPath },
        oldSide,
        status: classifyTrackedStatus(oldPath !== null, oldSide, newSide),
      },
    };
  }

  /** `staged`/`unstaged`/`working` sides via {@link readDiffSides}: old =
   * `HEAD:./<path>` for `staged`/`working`, or the INDEX (`:0:./<path>`) for
   * `unstaged` (BST-1113 review finding — see `StructuredFileDiffParams`'s
   * `unstaged` doc comment in `@brainstrike/types`); new = the index
   * (`staged`) or the worktree file (`unstaged`/`working`). */
  async function readTrackedSides(
    mode: 'staged' | 'unstaged' | 'working',
    pathArg: string,
    oldPath: string | null
  ): Promise<GitResult<TrackedSides>> {
    const oldSpec =
      mode === 'unstaged' ? `:0:./${oldPath ?? pathArg}` : `HEAD:./${oldPath ?? pathArg}`;
    return await readDiffSides(
      oldSpec,
      pathArg,
      () =>
        mode === 'staged' ? readRefBlob(`:0:./${pathArg}`, pathArg) : readWorktreeFile(pathArg),
      oldPath
    );
  }

  /** Assemble the `additions`/`content`/`deletions`/`hunks` fields once both
   * sides are known — the binary / cap / full branching, isolated from status
   * and side-reading so {@link structuredTrackedDiff} stays under the
   * complexity limit. Binary detection is checked FIRST and wins whenever
   * EITHER side was actually read and found to contain a null byte — an
   * `over-cap` side (never read) simply can't contribute evidence either
   * way, so it never blocks a confirmed-binary classification from the OTHER
   * side. `computeDiff` is injected (rather than a `mode` string) so this is
   * shared, unmodified, between `staged`/`working` and `commit`/`range`
   * (BST-1113) — every mode's over-cap/binary/`maxBuffer` handling is
   * IDENTICAL; only how the unified diff itself gets computed differs. */
  async function assembleDiffContent(
    computeDiff: () => Promise<GitResult<UnifiedDiffRun>>,
    entry: NumstatEntry,
    sides: Pick<TrackedSides, 'newSide' | 'oldSide'>
  ): Promise<GitResult<Pick<StructuredFileDiff, 'additions' | 'content' | 'deletions' | 'hunks'>>> {
    const { newSide, oldSide } = sides;
    const oldBinary = oldSide.kind === 'present' && oldSide.content.includes(0);
    const newBinary = newSide.kind === 'present' && newSide.content.includes(0);
    if (oldBinary || newBinary) {
      return {
        ok: true,
        value: { additions: null, content: { kind: 'binary' }, deletions: null, hunks: [] },
      };
    }

    const unifiedDiff = await computeDiff();
    if (!unifiedDiff.ok) {
      return unifiedDiff;
    }

    const oldOverCap = oldSide.kind === 'over-cap';
    const newOverCap = newSide.kind === 'over-cap';

    // A `maxBuffer` overflow on the diff invocation itself means `text` is a
    // possibly-malformed PARTIAL capture (git was killed mid-stream) — force
    // `hunks-only` regardless of whether either SIDE individually crossed the
    // per-file cap. Never claim `full` content with hunks silently short (or
    // worse, let a mid-header cutoff reach `parseHunkHeaders` as if it were a
    // complete diff and throw a confusing "malformed hunk header").
    if (unifiedDiff.value.truncated || oldOverCap || newOverCap) {
      const bounded = boundOutput(unifiedDiff.value.text);
      return {
        ok: true,
        value: {
          additions: entry.additions,
          content: {
            hunkText: bounded.text,
            hunkTextTruncated: bounded.truncated || unifiedDiff.value.truncated,
            kind: 'hunks-only',
            reason: resolveOverCapReason(oldOverCap, newOverCap),
          },
          deletions: entry.deletions,
          // Safe even on a `maxBuffer`-truncated raw capture: `boundOutput`'s
          // 1MB soft ceiling is always well under the 4MB hard buffer cap, so
          // it always re-truncates at a CLEAN boundary ending in the marker
          // line — exactly the shape `parseHunkHeaders` tolerates (a
          // hunk-header candidate immediately followed by the marker is
          // skipped, never thrown).
          hunks: parseHunkHeaders(bounded.text),
        },
      };
    }

    return {
      ok: true,
      value: {
        additions: entry.additions,
        content: {
          kind: 'full',
          newContent: newSide.kind === 'present' ? newSide.content.toString('utf8') : null,
          oldContent: oldSide.kind === 'present' ? oldSide.content.toString('utf8') : null,
        },
        deletions: entry.deletions,
        hunks: parseHunkHeaders(unifiedDiff.value.text),
      },
    };
  }

  /** Structured diff for the `working`/`staged`/`unstaged` modes: HEAD vs.
   * worktree/index, or (for `unstaged`) the index vs. worktree. */
  async function structuredTrackedDiff(
    mode: 'staged' | 'unstaged' | 'working',
    pathArg: string
  ): Promise<GitResult<StructuredFileDiff>> {
    const entryResult = await resolveTrackedEntryForPath(mode, pathArg);
    if (!entryResult.ok) {
      return entryResult;
    }
    const entry = entryResult.value;

    const sidesResult = await readTrackedSides(mode, pathArg, entry.oldPath);
    if (!sidesResult.ok) {
      return sidesResult;
    }
    const sides = sidesResult.value;

    const contentResult = await assembleDiffContent(
      () => computeUnifiedDiff(trackedNumstatTarget(mode), pathArg, entry.oldPath),
      entry,
      sides
    );
    if (!contentResult.ok) {
      return contentResult;
    }

    return {
      ok: true,
      value: {
        ...contentResult.value,
        ...sides.oldPathField,
        path: pathArg,
        status: sides.status,
      },
    };
  }

  /** `commit`/`range` numstat entry, or the correctly-directed error when
   * there isn't one — the ref-pair counterpart to
   * {@link resolveTrackedEntryForPath}. No untracked-redirect branch: `commit`
   * and `range` compare two historical/ref snapshots, and "untracked" (never
   * tracked by git at all) has no meaning for either. */
  async function resolveRefEntryForPath(
    oldRef: string,
    newRef: string,
    pathArg: string,
    modeLabel: 'commit' | 'range'
  ): Promise<GitResult<NumstatEntry>> {
    const entryResult = await resolveRefNumstatEntry(oldRef, newRef, pathArg);
    if (!entryResult.ok) {
      return entryResult;
    }
    if (entryResult.value) {
      return { ok: true, value: entryResult.value };
    }
    return { error: `no differences for '${pathArg}' in ${modeLabel} scope`, ok: false };
  }

  /**
   * Structured diff for the `commit`/`range` modes (BST-1113): two explicit
   * refs, both sides read via `readRefBlob` — never the worktree or index.
   * `oldRef`/`newRef` are already-resolved by the caller (`structuredFileDiff`
   * below resolves `commit` mode's `oldRef` via `resolveCommitOldRef`;
   * `range` mode's `oldRef` is the caller-supplied `baseRef` verbatim, and
   * its `newRef` is always the literal `'HEAD'` — see
   * `StructuredFileDiffParams`'s `range` doc comment in `@brainstrike/types`
   * for why HEAD, not the worktree). Mirrors {@link structuredTrackedDiff}'s
   * three-step shape (numstat entry → both sides → assemble content) via the
   * SAME {@link readDiffSides}/{@link assembleDiffContent} machinery.
   */
  async function structuredRefDiff(
    oldRef: string,
    newRef: string,
    pathArg: string,
    modeLabel: 'commit' | 'range'
  ): Promise<GitResult<StructuredFileDiff>> {
    const entryResult = await resolveRefEntryForPath(oldRef, newRef, pathArg, modeLabel);
    if (!entryResult.ok) {
      return entryResult;
    }
    const entry = entryResult.value;

    const sidesResult = await readDiffSides(
      `${oldRef}:./${entry.oldPath ?? pathArg}`,
      pathArg,
      () => readRefBlob(`${newRef}:./${pathArg}`, pathArg),
      entry.oldPath
    );
    if (!sidesResult.ok) {
      return sidesResult;
    }
    const sides = sidesResult.value;

    const contentResult = await assembleDiffContent(
      () => computeUnifiedDiff([oldRef, newRef], pathArg, entry.oldPath),
      entry,
      sides
    );
    if (!contentResult.ok) {
      return contentResult;
    }

    return {
      ok: true,
      value: {
        ...contentResult.value,
        ...sides.oldPathField,
        path: pathArg,
        status: sides.status,
      },
    };
  }

  return {
    /**
     * Both-sides file content + structured hunk ranges for one path (spec §3,
     * §11 Q3) — the `StructuredFileDiff` replacement for the unified-diff-string
     * `diff()` contract. `mode` selects the comparison: `working` (HEAD vs.
     * worktree, i.e. all uncommitted changes), `staged` (HEAD vs. index),
     * `untracked` (no HEAD/index side at all), `commit` (`<commitId>^` vs.
     * `<commitId>`, BST-1113), or `range` (a caller-resolved `baseRef` vs.
     * HEAD, BST-1113).
     */
    structuredFileDiff: async (
      params: StructuredFileDiffParams
    ): Promise<GitResult<StructuredFileDiff>> => {
      try {
        const validated = validateStructuredFileDiffParams(params);
        if (!validated.ok) {
          return validated;
        }
        const pathResult = resolveContainedPathArg(cwd, validated.value.path);
        if (!pathResult.ok) {
          return pathResult;
        }
        if (pathResult.value === null) {
          return { error: 'structured diff requires a non-empty path', ok: false };
        }
        const pathArg = pathResult.value;
        const validatedParams = validated.value;
        if (validatedParams.mode === 'untracked') {
          return await structuredUntrackedDiff(pathArg);
        }
        if (
          validatedParams.mode === 'staged' ||
          validatedParams.mode === 'unstaged' ||
          validatedParams.mode === 'working'
        ) {
          return await structuredTrackedDiff(validatedParams.mode, pathArg);
        }
        if (validatedParams.mode === 'commit') {
          const oldRef = await resolveCommitOldRef(invoke, validatedParams.commitId);
          if (!oldRef.ok) {
            return oldRef;
          }
          return await structuredRefDiff(oldRef.value, validatedParams.commitId, pathArg, 'commit');
        }
        return await structuredRefDiff(validatedParams.baseRef, 'HEAD', pathArg, 'range');
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
