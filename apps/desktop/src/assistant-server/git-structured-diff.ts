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
 */
import { lstat, readFile, readlink } from 'node:fs/promises';
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
  toErrorMessage,
} from './git-service';
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
 * edit-checkpoint journal's per-file capture cap (`MAX_WRITE_WORKSPACE_FILE_BYTES`
 * in `file-mutation-tools.ts`, `2_000_000` bytes) — both exist so a single file
 * can't blow main-process memory on a read that has to hold full before/after
 * text. The two constants are NOT byte-identical today (`2 * 1024 * 1024` here
 * vs `2_000_000` there); this is the structured-diff engine's own cap, but the
 * two should move together if either is revisited.
 */
export const STRUCTURED_DIFF_CONTENT_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Exit-128 stderr wording `git cat-file blob` uses for an ABSENT object spec —
 * empirically confirmed against real git 2.54 in a scratch repo (never guessed):
 * - `HEAD:<path>` never existed at HEAD → "does not exist in 'HEAD'"
 * - `HEAD:<path>` before the first commit (unborn HEAD) → "invalid object name 'HEAD'."
 * - `:0:<path>` with no index entry at all → "does not exist (neither on disk nor in the index)"
 * - `:0:<path>` present on disk but not staged (e.g. `git rm --cached`) →
 *   "exists on disk, but not in the index"
 * - `:0:<path>` mid-merge-conflict (no stage-0 entry) → "is in the index, but not at stage 0"
 * ANY other exit-128 stderr (a real read error) must NOT match this and falls
 * through to `ok: false` — this is the spike's exact absent-vs-error bug.
 */
const CAT_FILE_ABSENT_STDERR_PATTERN =
  /does not exist|exists on disk, but not in|invalid object name|is in the index, but not at stage/;

/** Pure status classification for a tracked-mode structured diff entry. */
function classifyTrackedStatus(
  isRename: boolean,
  oldContent: Buffer | null,
  newContent: Buffer | null
): ChangedFileStatus {
  if (isRename) {
    return 'renamed';
  }
  if (oldContent === null) {
    return 'added';
  }
  return newContent === null ? 'deleted' : 'modified';
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
 * Count lines the way {@link countLines} (`structured-diff-parsers.ts`)
 * counts them — newline-terminated text counts the terminated lines, not an
 * extra trailing empty segment — but operating directly on raw bytes so an
 * over-cap buffer never needs a full utf8 transcode just to get a line count.
 */
function countLinesInBuffer(buffer: Buffer): number {
  if (buffer.byteLength === 0) {
    return 0;
  }
  let newlineCount = 0;
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] === 0x0a) {
      newlineCount += 1;
    }
  }
  const endsWithNewline = buffer[buffer.byteLength - 1] === 0x0a;
  return endsWithNewline ? newlineCount : newlineCount + 1;
}

/** Validate {@link StructuredFileDiffParams}: unlike `validateDiffParams` in `git-service.ts`, `path` is required in EVERY mode. */
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
  const unsupportedKeys = Object.keys(record).filter((key) => key !== 'mode' && key !== 'path');
  if (unsupportedKeys.length > 0) {
    return {
      error: `structured diff only accepts "mode" and "path"; received ${unsupportedKeys.join(', ')}`,
      ok: false,
    };
  }
  if (
    record['mode'] !== 'working' &&
    record['mode'] !== 'staged' &&
    record['mode'] !== 'untracked'
  ) {
    return { error: 'structured diff mode must be "working", "staged", or "untracked"', ok: false };
  }
  if (typeof record['path'] !== 'string' || record['path'].length === 0) {
    return { error: 'structured diff requires a non-empty path', ok: false };
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
  readonly newContent: Buffer | null;
  readonly oldContent: Buffer | null;
  readonly oldPathField: { oldPath?: string };
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
   * Read one ref-addressed blob (`HEAD:<path>` or `:0:<path>`) via `cat-file
   * blob`, classifying the result into present / absent / hard-error. A
   * `maxBuffer` overflow is ALWAYS a hard failure here (never a truncated
   * success): unlike a diff, a blob has no self-describing boundary a caller
   * could use to detect a silent truncation (see `GitCommandRun.stdoutBuffer`).
   */
  async function readRefBlob(spec: string): Promise<GitResult<Buffer | null>> {
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
      return { ok: true, value: run_.stdoutBuffer };
    }
    if (run_.exitCode === 128 && CAT_FILE_ABSENT_STDERR_PATTERN.test(run_.stderr)) {
      return { ok: true, value: null };
    }
    return { error: describeFailure(run_), ok: false };
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
   */
  async function readWorktreeFile(pathArg: string): Promise<GitResult<Buffer | null>> {
    const containment = await assertUntrackedDiffPathContained(cwd, pathArg);
    if (!containment.ok) {
      return containment;
    }
    const resolved = path.resolve(cwd, pathArg);
    try {
      const stats = await lstat(resolved);
      if (stats.isSymbolicLink()) {
        const target = await readlink(resolved);
        return { ok: true, value: Buffer.from(target, 'utf8') };
      }
      const buffer = await readFile(resolved);
      return { ok: true, value: buffer };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, value: null };
      }
      return { error: toErrorMessage(error), ok: false };
    }
  }

  /** True when `pathArg` (scoped to the opened root) shows as untracked in status. */
  async function isPathUntracked(pathArg: string): Promise<GitResult<boolean>> {
    const run_ = await invoke([
      'status',
      '--porcelain=v2',
      '--untracked-files=all',
      '-z',
      '--',
      pathArg,
    ]);
    if (run_.exitCode !== 0) {
      return { error: describeFailure(run_), ok: false };
    }
    const parsed = parsePorcelainV2Z(run_.stdout);
    return {
      ok: true,
      value: parsed.files.some((file) => file.untracked && file.path === pathArg),
    };
  }

  async function computeUnifiedDiff(
    mode: 'staged' | 'untracked' | 'working',
    pathArg: string,
    oldPath: string | null
  ): Promise<GitResult<UnifiedDiffRun>> {
    const untracked = mode === 'untracked';
    const args = untracked
      ? ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', pathArg]
      : [
          'diff',
          ...(mode === 'staged' ? ['--cached'] : ['HEAD']),
          '--no-ext-diff',
          '--no-textconv',
          '--find-renames',
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
   * silence rename detection for exactly the record we need it for. The numstat
   * text output (paths + counts, no content) stays bounded by the same
   * `GIT_MAX_OUTPUT_BYTES`/`GIT_MAX_BUFFER_BYTES` ceiling as every other git
   * invocation in `git-service.ts`.
   */
  async function resolveNumstatEntry(
    mode: 'staged' | 'working',
    pathArg: string
  ): Promise<GitResult<NumstatEntry | null>> {
    const numstatRun = await invoke([
      'diff',
      ...(mode === 'staged' ? ['--cached'] : ['HEAD']),
      '--numstat',
      '-z',
      '--find-renames',
      '--',
      '.',
    ]);
    if (numstatRun.exitCode !== 0) {
      return { error: describeFailure(numstatRun), ok: false };
    }
    const entries = parseNumstatZ(numstatRun.stdout);
    return { ok: true, value: entries.find((candidate) => candidate.path === pathArg) ?? null };
  }

  /** Structured diff for the `untracked` mode: no HEAD/index side, whole-file addition. */
  async function structuredUntrackedDiff(pathArg: string): Promise<GitResult<StructuredFileDiff>> {
    const worktreeRead = await readWorktreeFile(pathArg);
    if (!worktreeRead.ok) {
      return worktreeRead;
    }
    if (worktreeRead.value === null) {
      return { error: `no differences for '${pathArg}' in untracked scope`, ok: false };
    }
    const content = worktreeRead.value;
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
    // Cap check BEFORE decoding: an over-cap file's decoded string is never
    // kept as `content.newContent` (only `full` content stores one), and
    // `additions` for an over-cap buffer is counted directly on the bytes
    // ({@link countLinesInBuffer}) instead of via a full utf8 transcode.
    if (content.byteLength > STRUCTURED_DIFF_CONTENT_CAP_BYTES) {
      // Over cap: still show a bounded preview via `git diff --no-index` —
      // the same whole-file-addition preview a caller would get for any other
      // over-cap file, just with `hunks` staying empty (untracked mode never
      // populates it: there is no "old side" for hunk ranges to be relative
      // to).
      const unifiedDiff = await computeUnifiedDiff('untracked', pathArg, null);
      if (!unifiedDiff.ok) {
        return unifiedDiff;
      }
      const bounded = boundOutput(unifiedDiff.value.text);
      return {
        ok: true,
        value: {
          additions: countLinesInBuffer(content),
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
    mode: 'staged' | 'working',
    pathArg: string
  ): Promise<GitResult<NumstatEntry>> {
    const entryResult = await resolveNumstatEntry(mode, pathArg);
    if (!entryResult.ok) {
      return entryResult;
    }
    if (entryResult.value) {
      return { ok: true, value: entryResult.value };
    }
    if (mode === 'working') {
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

  /** Read both sides of a tracked-mode diff and classify status — split out to
   * keep {@link structuredTrackedDiff}'s cognitive complexity under the limit. */
  async function readTrackedSides(
    mode: 'staged' | 'working',
    pathArg: string,
    oldPath: string | null
  ): Promise<GitResult<TrackedSides>> {
    const oldRead = await readRefBlob(`HEAD:${oldPath ?? pathArg}`);
    if (!oldRead.ok) {
      return oldRead;
    }
    const newRead =
      mode === 'staged' ? await readRefBlob(`:0:${pathArg}`) : await readWorktreeFile(pathArg);
    if (!newRead.ok) {
      return newRead;
    }
    const oldContent = oldRead.value;
    const newContent = newRead.value;
    return {
      ok: true,
      value: {
        newContent,
        oldContent,
        oldPathField: oldPath === null ? {} : { oldPath },
        status: classifyTrackedStatus(oldPath !== null, oldContent, newContent),
      },
    };
  }

  /** Assemble the `additions`/`content`/`deletions`/`hunks` fields once both
   * sides are known — the binary / cap / full branching, isolated from status
   * and side-reading so {@link structuredTrackedDiff} stays under the
   * complexity limit. */
  async function assembleTrackedContent(
    mode: 'staged' | 'working',
    pathArg: string,
    oldPath: string | null,
    entry: NumstatEntry,
    sides: Pick<TrackedSides, 'newContent' | 'oldContent'>
  ): Promise<GitResult<Pick<StructuredFileDiff, 'additions' | 'content' | 'deletions' | 'hunks'>>> {
    const { newContent, oldContent } = sides;
    if (oldContent?.includes(0) || newContent?.includes(0)) {
      return {
        ok: true,
        value: { additions: null, content: { kind: 'binary' }, deletions: null, hunks: [] },
      };
    }

    const unifiedDiff = await computeUnifiedDiff(mode, pathArg, oldPath);
    if (!unifiedDiff.ok) {
      return unifiedDiff;
    }

    const oldOverCap =
      oldContent !== null && oldContent.byteLength > STRUCTURED_DIFF_CONTENT_CAP_BYTES;
    const newOverCap =
      newContent !== null && newContent.byteLength > STRUCTURED_DIFF_CONTENT_CAP_BYTES;

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
          newContent: newContent === null ? null : newContent.toString('utf8'),
          oldContent: oldContent === null ? null : oldContent.toString('utf8'),
        },
        deletions: entry.deletions,
        hunks: parseHunkHeaders(unifiedDiff.value.text),
      },
    };
  }

  /** Structured diff for the `working`/`staged` modes: HEAD vs. worktree/index. */
  async function structuredTrackedDiff(
    mode: 'staged' | 'working',
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

    const contentResult = await assembleTrackedContent(mode, pathArg, entry.oldPath, entry, sides);
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
     * worktree, i.e. all uncommitted changes), `staged` (HEAD vs. index), or
     * `untracked` (no HEAD/index side at all).
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
        return validated.value.mode === 'untracked'
          ? await structuredUntrackedDiff(pathArg)
          : await structuredTrackedDiff(validated.value.mode, pathArg);
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
