/**
 * Pure, dependency-injected git operations for the desktop `git` IPC domain.
 *
 * This module has NO Electron imports so it is hermetically testable against a
 * real temp git repository (see `git-service.integration.test.ts`). It exposes
 * typed working-tree, repository, branch, history, commit, and network
 * operations, each of which:
 *
 * - runs `git` via an injected `execFile`-style runner (NEVER a shell, NEVER
 *   `execSync`). Every argument (branch name, commit message, path) is passed as
 *   a separate array element, so no value can be shell-interpolated or inject a
 *   command. There is no `exec`/`spawn shell:true` anywhere in this file.
 * - resolves git failures into structured `{ ok: false, error }` results rather
 *   than throwing across the IPC boundary (no-silent-fallbacks: the stderr /
 *   message is surfaced, never swallowed).
 * - bounds the captured output so a runaway diff cannot exhaust memory.
 *
 * The caller (the IPC handler) is responsible for resolving + containment-
 * checking the `cwd` against a known workspace root before calling in here.
 *
 * The `StructuredFileDiff` engine (both-sides content + hunk ranges for one
 * path) lives in `git-structured-diff.ts`, and the `history`/
 * `commitFiles` ops live in `git-history.ts` (BST-1111, BST-1118) — this
 * module re-exports the former's public constant and wires both factories
 * into `createGitService`'s returned op set.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  GitAheadBehind,
  GitBranchSummary,
  GitCommitResult,
  GitCreateBranchResult,
  GitDiff,
  GitDiffParams,
  GitForgeRepositoryContext,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitStatusFile,
  GitSwitchBranchResult,
  GitWorktreeSummary,
} from '@brainstrike/types';
import { resolveForgeRemoteName } from '@brainstrike/types';
import { createHistoryOps } from './git-history';
import { parseBranchSummaries, parseWorktreeSummaries } from './git-repository-parsers';
import { createStructuredDiffOps, STRUCTURED_DIFF_CONTENT_CAP_BYTES } from './git-structured-diff';

export type {
  GitAheadBehind,
  GitBranchSummary,
  GitCommitFile,
  GitCommitResult,
  GitCreateBranchResult,
  GitDiff,
  GitDiffParams,
  GitForgeRepositoryContext,
  GitHistoryCommit,
  GitHistoryPage,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitStatusFile,
  GitSwitchBranchResult,
  GitWorktreeSummary,
} from '@brainstrike/types';

export const GIT_DEFAULT_TIMEOUT_MS = 30_000;
/** Push / pull can hang on auth or a slow network — give them a longer leash. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;
/**
 * Soft ceiling on captured stdout/stderr that the SERVICE applies via
 * {@link boundOutput} — output past this is truncated to a `truncated: true`
 * success, NOT a failure.
 */
export const GIT_MAX_OUTPUT_BYTES = 1_000_000;
/**
 * Hard `execFile` capture buffer. Strictly LARGER than {@link GIT_MAX_OUTPUT_BYTES}
 * so a diff between the soft and hard ceiling is captured in full and gracefully
 * truncated by {@link boundOutput} (success) rather than killed by `maxBuffer`
 * first (which would surface a legitimate big diff as a failure). A diff that
 * exceeds even this hard ceiling overflows `maxBuffer`; the runner maps that to a
 * bounded `truncated: true` success via {@link GitCommandFailureReason} rather
 * than a null-exit error.
 */
export const GIT_MAX_BUFFER_BYTES = GIT_MAX_OUTPUT_BYTES * 4;
/**
 * Per-side full-content cap for `StructuredFileDiff`. Defined in
 * `git-structured-diff.ts` (the structured-diff engine's own cap); re-exported
 * here so existing importers of `git-service.ts` keep their import path.
 */
export { STRUCTURED_DIFF_CONTENT_CAP_BYTES };

/**
 * Distinguishes the cause of a non-clean `git` run so the service maps each to an
 * accurate result. `killed === true` alone conflates three causes — the runner
 * sets this discriminant instead so a `maxBuffer` overflow becomes a truncated
 * SUCCESS, an abort/timeout becomes the right message, and a missing binary is
 * reported clearly.
 */
export type GitCommandFailureReason = 'maxBuffer' | 'timeout' | 'notFound';

/** Result of running a single `git` invocation through the injected runner. */
export interface GitCommandRun {
  /** Process exit code, or null when terminated by a signal (timeout/abort). */
  readonly exitCode: number | null;
  /** Discriminated failure cause when the run did not exit cleanly. */
  readonly failureReason?: GitCommandFailureReason;
  readonly stderr: string;
  readonly stdout: string;
  /**
   * Populated ONLY when the run was requested with `binaryStdout: true` — the
   * exact captured bytes (no utf8 decode). When present, {@link stdout} is `''`.
   * Undefined for every other run, including today's text-mode callers.
   *
   * On a CLEAN run (`exitCode === 0`, no {@link failureReason}) this is the
   * complete blob content — safe to treat as-is.
   *
   * When {@link failureReason} or a non-zero {@link exitCode} is set, this
   * buffer is a possibly-empty, possibly-TRUNCATED partial capture — an empty
   * Buffer here is NOT evidence of an empty blob, it just means nothing (or
   * nothing more) was captured before the run failed. Do NOT reuse the text
   * path's `exitCode === 0 || failureReason === 'maxBuffer'` "truncated is
   * still success" pattern for binary reads: unlike a diff, a git blob has no
   * self-describing boundary a caller can use to detect that it was cut off,
   * so presenting a truncated blob as complete would be silent corruption.
   * `failureReason === 'maxBuffer'` MUST be treated as a hard failure for
   * binary reads, never a bounded success.
   */
  readonly stdoutBuffer?: Buffer;
  /** True when the invocation was killed because it exceeded its timeout. */
  readonly timedOut: boolean;
}

/**
 * Structural runner contract — `runGitCommand` below adapts Node's
 * `child_process.execFile` to this, and tests can inject a fake. The runner MUST
 * pass `args` to the `git` binary verbatim (no shell), pin `cwd`, and resolve
 * (never reject) with the captured streams + exit code.
 */
export type GitCommandRunner = (params: {
  readonly args: readonly string[];
  /**
   * When true, the runner captures stdout as raw bytes into
   * {@link GitCommandRun.stdoutBuffer} instead of decoding it as utf8 text —
   * required for reading a blob that may contain arbitrary binary content (a
   * lossy text decode would mangle it before any caller can inspect the bytes).
   */
  readonly binaryStdout?: boolean | undefined;
  readonly cwd: string;
  /**
   * Extra environment variables merged OVER the runner's pinned base
   * environment (never replacing it wholesale) — e.g. a private
   * `GIT_INDEX_FILE` for an isolated staging operation. After that merge, the
   * runner MUST re-apply `GIT_TERMINAL_PROMPT=0`, `GIT_LITERAL_PATHSPECS=1`,
   * and `LC_ALL=C`; those safety-pinned keys are never caller-overridable.
   * Optional; most callers omit it and get the runner's ordinary pinned
   * environment.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}) => Promise<GitCommandRun>;

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove Git's platform record terminator without consuming a POSIX literal CR. */
export function stripLineEnding(value: string): string {
  if (!value.endsWith('\n')) {
    return value;
  }
  const withoutLf = value.slice(0, -1);
  if (process.platform === 'win32' && withoutLf.endsWith('\r')) {
    return withoutLf.slice(0, -1);
  }
  return withoutLf;
}

function splitLineRecords(value: string): readonly string[] {
  const records = stripLineEnding(value).split('\n');
  if (process.platform !== 'win32') {
    return records;
  }
  return records.map((record) => (record.endsWith('\r') ? record.slice(0, -1) : record));
}

function parseGitVersion(value: string): readonly [number, number, number] | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isAtLeastGit236(version: readonly [number, number, number]): boolean {
  return version[0] > 2 || (version[0] === 2 && version[1] >= 36);
}

/** Bound a captured stream to the size budget, keeping the head (where git's
 * summary / errors lead) plus a truncation marker. */
export function boundOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= GIT_MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, GIT_MAX_OUTPUT_BYTES)}\n…(output truncated)`,
    truncated: true,
  };
}

/** True when a failed `git` run was a "not a repository" fatal (exit 128). */
function isNotARepository(run: GitCommandRun): boolean {
  return /not a git repository/i.test(run.stderr);
}

/**
 * Combine a failed run's stderr/stdout into a single actionable error string.
 * Never silent: a discriminated `failureReason` wins (so a timeout, abort, or
 * missing-binary case reports accurately instead of dumping a stale exit code);
 * otherwise we surface stderr/stdout, then the exit code as a last resort.
 */
export function describeFailure(run: GitCommandRun): string {
  if (run.failureReason === 'timeout') {
    return 'git command timed out';
  }
  if (run.failureReason === 'notFound') {
    return 'git is not installed or not on PATH';
  }
  const stderr = run.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  const stdout = run.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }
  return `git exited with code ${run.exitCode ?? 'null (terminated by signal)'}`;
}

export function describeDiffFailure(run: GitCommandRun, untracked: boolean): string | null {
  if (run.exitCode === 0 || run.failureReason === 'maxBuffer') {
    return null;
  }
  if (!(untracked && run.exitCode === 1)) {
    return describeFailure(run);
  }
  if (run.stdout.length > 0) {
    return null;
  }
  return run.stderr.trim() || 'git returned no diff for the untracked path';
}

/**
 * Map a single porcelain-v2 ordinary/rename entry into a {@link GitStatusFile}.
 *
 * Ordinary:  `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 * Rename/copy: `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Rscore> <path>\t<origPath>`
 *
 * `XY` is the staged (X) + unstaged (Y) status pair; `.` means unchanged on
 * that side.
 */
function parseTrackedEntry(line: string, isRename: boolean): GitStatusFile | null {
  // Split off the path portion: for renames the path is "<new>\t<orig>" and may
  // itself contain spaces, so we cannot naively split the whole line on spaces.
  const headerFieldCount = isRename ? 10 : 9;
  const fields = line.split(' ');
  if (fields.length < headerFieldCount) {
    return null;
  }
  const xy = fields[1] ?? '..';
  const stagedCode = xy[0] ?? '.';
  const unstagedCode = xy[1] ?? '.';
  const staged = stagedCode !== '.';
  const unstaged = unstagedCode !== '.';
  // The path field begins after the fixed-width header columns. Rejoin the rest
  // (it can contain spaces) then, for renames, split new\torig on the tab.
  const pathPortion = fields.slice(headerFieldCount - 1).join(' ');
  if (isRename) {
    const tabIndex = pathPortion.indexOf('\t');
    const newPath = tabIndex >= 0 ? pathPortion.slice(0, tabIndex) : pathPortion;
    const originalPath = tabIndex >= 0 ? pathPortion.slice(tabIndex + 1) : undefined;
    return {
      path: newPath,
      ...(originalPath ? { originalPath } : {}),
      staged,
      status: staged ? stagedCode : unstagedCode,
      unstaged,
      untracked: false,
    };
  }
  return {
    path: pathPortion,
    staged,
    status: staged ? stagedCode : unstagedCode,
    unstaged,
    untracked: false,
  };
}

/** Mutable accumulator for the branch-header fields of porcelain v2. */
interface BranchHeader {
  ahead: number | null;
  behind: number | null;
  branch: string | null;
  upstream: string | null;
}

/**
 * Apply a `# branch.*` header line to {@link BranchHeader}. Returns true when the
 * line was a recognized header (so the caller can stop processing it).
 */
function applyBranchHeader(line: string, header: BranchHeader): boolean {
  if (line.startsWith('# branch.head ')) {
    const value = line.slice('# branch.head '.length).trim();
    header.branch = value === '(detached)' ? null : value;
    return true;
  }
  if (line.startsWith('# branch.upstream ')) {
    header.upstream = line.slice('# branch.upstream '.length).trim() || null;
    return true;
  }
  if (line.startsWith('# branch.ab ')) {
    // Format: "+<ahead> -<behind>"
    const parts = line.slice('# branch.ab '.length).trim().split(/\s+/);
    const aheadRaw = Number.parseInt((parts[0] ?? '').replace('+', ''), 10);
    const behindRaw = Number.parseInt((parts[1] ?? '').replace('-', ''), 10);
    header.ahead = Number.isNaN(aheadRaw) ? null : aheadRaw;
    header.behind = Number.isNaN(behindRaw) ? null : behindRaw;
    return true;
  }
  return line.startsWith('# ');
}

/** Parse a single non-header porcelain v2 line into a file entry (or null). */
function parseStatusLine(line: string): GitStatusFile | null {
  if (line.startsWith('1 ')) {
    return parseTrackedEntry(line, false);
  }
  if (line.startsWith('2 ')) {
    return parseTrackedEntry(line, true);
  }
  if (line.startsWith('? ')) {
    return {
      path: line.slice(2),
      staged: false,
      status: '?',
      unstaged: false,
      untracked: true,
    };
  }
  if (line.startsWith('u ')) {
    // Unmerged: path begins after the 10 fixed header columns.
    const pathPortion = line.split(' ').slice(10).join(' ');
    if (pathPortion.length > 0) {
      return { path: pathPortion, staged: true, status: 'U', unstaged: true, untracked: false };
    }
  }
  return null;
}

/**
 * Parse `git status --porcelain=v2 --branch` output into a {@link GitStatus}.
 * Pure and exported for direct unit testing.
 */
export function parsePorcelainV2(stdout: string): Omit<GitStatus, 'isRepository'> {
  const header: BranchHeader = { ahead: null, behind: null, branch: null, upstream: null };
  const files: GitStatusFile[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('# ')) {
      applyBranchHeader(line, header);
      continue;
    }
    const file = parseStatusLine(line);
    if (file) {
      files.push(file);
    }
  }

  return {
    ahead: header.ahead,
    behind: header.behind,
    branch: header.branch,
    clean: files.length === 0,
    files,
    upstream: header.upstream,
  };
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. Unlike the line format above,
 * paths are literal and NUL-terminated, so tabs/newlines and rename paths are
 * unambiguous. This is the production parser; the line parser remains exported
 * for its narrow pure-format tests and backwards compatibility.
 */
export function parsePorcelainV2Z(stdout: string): Omit<GitStatus, 'isRepository'> {
  const header: BranchHeader = { ahead: null, behind: null, branch: null, upstream: null };
  const files: GitStatusFile[] = [];
  const fields = stdout.split('\0');

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    if (field.length === 0) {
      continue;
    }
    if (field.startsWith('# ')) {
      applyBranchHeader(field, header);
      continue;
    }
    if (field.startsWith('2 ')) {
      const parsed = parseTrackedEntry(field, true);
      const originalPath = fields[index + 1];
      if (!(parsed && originalPath)) {
        throw new Error('git returned malformed NUL-delimited rename status');
      }
      index += 1;
      files.push({ ...parsed, originalPath });
      continue;
    }
    const parsed = parseStatusLine(field);
    if (!parsed) {
      throw new Error('git returned malformed NUL-delimited status');
    }
    files.push(parsed);
  }

  return {
    ahead: header.ahead,
    behind: header.behind,
    branch: header.branch,
    clean: files.length === 0,
    files,
    upstream: header.upstream,
  };
}

/**
 * Rebase git-reported (repo-root-relative) status paths onto `repositoryPrefix`
 * (the `rev-parse --show-prefix` value for the invocation `cwd`) so every path
 * this service surfaces is relative to the SAME base the caller passed in —
 * exported for `git-structured-diff.ts`'s `isPathUntracked`, which needs the
 * identical cwd-relative rebasing for status paths.
 */
export function scopeStatusPaths(
  status: Omit<GitStatus, 'isRepository'>,
  repositoryPrefix: string
): GitResult<Omit<GitStatus, 'isRepository'>> {
  if (repositoryPrefix.length === 0) {
    return { ok: true, value: status };
  }
  const scopePath = (filePath: string): GitResult<string> => {
    if (!filePath.startsWith(repositoryPrefix)) {
      return { error: `git returned path "${filePath}" outside the opened folder`, ok: false };
    }
    const relative = filePath.slice(repositoryPrefix.length);
    return relative.length > 0
      ? { ok: true, value: relative }
      : { error: 'git returned an empty path for the opened folder', ok: false };
  };
  const files: GitStatusFile[] = [];
  for (const file of status.files) {
    const scopedPath = scopePath(file.path);
    if (!scopedPath.ok) {
      return scopedPath;
    }
    if (file.originalPath) {
      const scopedOriginal = scopePath(file.originalPath);
      if (!scopedOriginal.ok) {
        return scopedOriginal;
      }
      files.push({ ...file, originalPath: scopedOriginal.value, path: scopedPath.value });
    } else {
      files.push({ ...file, path: scopedPath.value });
    }
  }
  return { ok: true, value: { ...status, files } };
}

/**
 * Resolve + CONTAIN a renderer/model-supplied path arg to a repo-root-relative
 * pathspec, or reject it.
 *
 * `cwd` is already pinned to the opened root, but a returned `git status` path
 * from a root that is a subdirectory of a larger worktree, or a malicious arg,
 * could be `../sibling/file` or absolute — git would happily diff/stage that,
 * escaping the opened folder. So this rejects:
 * - absolute paths, and
 * - any path that normalizes to an escape (leading `..`).
 *
 * `undefined` → `null` (caller scopes the whole opened root via '.'). Explicit
 * filenames are preserved byte-for-byte; whitespace and backslashes are valid
 * filename characters on POSIX and must never be coerced into another path.
 */
export function resolveContainedPathArg(
  basePath: string,
  rawPath: string | undefined
): GitResult<string | null> {
  if (rawPath === undefined) {
    return { ok: true, value: null };
  }
  if (rawPath.length === 0) {
    return { error: 'path must be a non-empty string', ok: false };
  }
  if (path.isAbsolute(rawPath)) {
    return { error: `path "${rawPath}" must be relative to the opened folder`, ok: false };
  }
  const resolved = path.resolve(basePath, rawPath);
  const relative = path.relative(basePath, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: `path "${rawPath}" escapes the opened folder`, ok: false };
  }
  return { ok: true, value: rawPath };
}

function validateDiffParams(params: GitDiffParams): GitResult<GitDiffParams> {
  if (!(params && typeof params === 'object') || Array.isArray(params)) {
    return { error: 'diff params must be an object with an explicit diff mode', ok: false };
  }
  const record = params as unknown as Record<string, unknown>;
  const unsupportedKeys = Object.keys(record).filter((key) => key !== 'mode' && key !== 'path');
  if (unsupportedKeys.length > 0) {
    return {
      error: `diff mode only accepts "mode" and "path"; received ${unsupportedKeys.join(', ')}`,
      ok: false,
    };
  }
  if (
    record['mode'] !== 'working' &&
    record['mode'] !== 'staged' &&
    record['mode'] !== 'untracked'
  ) {
    return {
      error: 'diff mode must be "working", "staged", or "untracked"',
      ok: false,
    };
  }
  if (record['path'] !== undefined && typeof record['path'] !== 'string') {
    return { error: 'diff path must be a string', ok: false };
  }
  if (record['mode'] === 'untracked' && typeof record['path'] !== 'string') {
    return { error: 'untracked diff requires a path', ok: false };
  }
  return { ok: true, value: params };
}

/**
 * SECURITY: the untracked diff path is handed to `git diff --no-index`, which
 * reads the filesystem directly. `resolveContainedPathArg` only validates
 * LEXICAL containment (relative, no `..`). The real escape is a symlinked
 * ANCESTOR directory: `git diff --no-index -- /dev/null sym-dir/file` resolves
 * THROUGH the symlink and renders the out-of-root file's CONTENT (mode 100644).
 *
 * So validate the PARENT chain's real path — but DO NOT dereference the final
 * component. A leaf symlink is safe to allow: git `lstat`s the final operand, so
 * it never reads the target's content. A leaf symlink to a FILE renders as a
 * `120000` addition whose body is the link TEXT (the target PATH, e.g.
 * `../outside/secret.txt`) — a benign, intentional disclosure already present in
 * the user's own working tree, not a content leak. A leaf symlink to a DIRECTORY
 * makes `git diff --no-index` fail (`Could not access '<link>/null'`), and the
 * service surfaces that failure visibly. Either way no out-of-root CONTENT
 * reaches the diff — that is the security property. `git status` lists such
 * untracked symlinks. Dereferencing the leaf here would wrongly reject valid
 * file-symlink additions (and throw on a dangling target). Tracked diffs don't
 * need this: they go through git's index, which never follows fs symlinks.
 */
export async function assertUntrackedDiffPathContained(
  cwd: string,
  pathArg: string
): Promise<GitResult<null>> {
  const parent = path.dirname(path.resolve(cwd, pathArg));
  try {
    const [realRoot, realParent] = await Promise.all([realpath(cwd), realpath(parent)]);
    // The parent must be the opened root itself ('' relative) or a descendant of
    // it. A `..`/absolute relative means a symlinked ancestor escaped the root.
    const relative = path.relative(realRoot, realParent);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { error: `path "${pathArg}" resolves outside the opened folder`, ok: false };
    }
    return { ok: true, value: null };
  } catch {
    // realpath throws if the parent directory does not exist; we cannot prove
    // containment, so refuse rather than risk an escape.
    return { error: `path "${pathArg}" could not be resolved inside the opened folder`, ok: false };
  }
}

export interface GitServiceOptions {
  readonly cwd: string;
  readonly run: GitCommandRunner;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Hook-free `git` invocation, extracted from `createGitService`'s inner
 * `invokeHookFree` closure so callers OUTSIDE a `GitServiceOptions`-bound
 * service (namely `git-inventory-service.ts`, which spawns `git` in
 * discovered, untrusted repositories one unique common dir at a time — never
 * through `createGitService`'s single fixed `cwd`) can reuse the exact same
 * hook-disabling logic instead of bare-spawning. `createGitService`'s
 * `invokeHookFree` now delegates here — zero behavior change.
 *
 * Git 2.54 added config-managed hooks that bypass `core.hooksPath`. This
 * enumerates their friendly names and disables them at command scope, on top
 * of `core.fsmonitor=false -c core.hooksPath=/dev/null`, before running `args`.
 * `invoke` is the caller's own git runner, already bound to a `cwd`.
 */
export async function invokeGitHookFree(
  invoke: (args: readonly string[], timeoutMs?: number) => Promise<GitCommandRun>,
  args: readonly string[],
  timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS
): Promise<GitCommandRun> {
  // This probe itself is the ONE spawn not preceded by `-c
  // core.fsmonitor=false -c core.hooksPath=/dev/null` (those flags are
  // computed FROM its result, below). Pre-existing and almost certainly
  // harmless — `git config` never reads the index or runs hooks — but note
  // that since `git-inventory-service.ts` started reusing this helper, it now
  // runs against arbitrary discovered repositories, not just one
  // user-chosen root.
  const configuredHooks = await invoke([
    'config',
    '--null',
    '--name-only',
    '--get-regexp',
    '^hook\\..*\\.command$',
  ]);
  if (configuredHooks.exitCode !== 0 && configuredHooks.exitCode !== 1) {
    return configuredHooks;
  }
  const disabledConfiguredHooks = configuredHooks.stdout
    .split('\0')
    .filter(Boolean)
    .flatMap((key) => ['-c', `${key.slice(0, -'.command'.length)}.enabled=false`]);
  const hookConfig = ['core.fsmonitor=false', 'core.hooksPath=/dev/null'].flatMap((value) => [
    '-c',
    value,
  ]);
  // No caller needs `binaryStdout` here today (only `readRefBlob`'s plain
  // `invoke` reads binary blobs; every hook-free call is text-mode unified-diff
  // or porcelain output) — re-add the pass-through param if that changes.
  return await invoke([...hookConfig, ...disabledConfiguredHooks, ...args], timeoutMs);
}

/**
 * Build the git operations bound to a single, already-validated `cwd`.
 *
 * Every method returns a {@link GitResult}: a git failure becomes
 * `{ ok: false, error }`, never a throw. The injected `run` is the ONLY way git
 * is invoked, and it always uses `execFile` semantics (args array, no shell).
 */
export function createGitService({ cwd, run, signal }: GitServiceOptions) {
  async function invoke(
    args: readonly string[],
    timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS,
    binaryStdout?: boolean
  ): Promise<GitCommandRun> {
    return await run({ args, binaryStdout, cwd, signal, timeoutMs });
  }

  async function invokeHookFree(
    args: readonly string[],
    timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS
  ): Promise<GitCommandRun> {
    return await invokeGitHookFree(invoke, args, timeoutMs);
  }

  async function resolveWorktreeRoot(): Promise<GitResult<string>> {
    const run_ = await invoke(['rev-parse', '--path-format=absolute', '--show-toplevel']);
    if (run_.exitCode !== 0) {
      return { error: describeFailure(run_), ok: false };
    }
    const worktreeRoot = stripLineEnding(run_.stdout);
    if (worktreeRoot.length === 0) {
      return { error: 'git returned an empty worktree root', ok: false };
    }
    return { ok: true, value: worktreeRoot };
  }

  async function requireNulSafeWorktreeInventory(): Promise<GitResult<null>> {
    const run_ = await invoke(['version']);
    if (run_.exitCode !== 0) {
      return { error: describeFailure(run_), ok: false };
    }
    const version = parseGitVersion(stripLineEnding(run_.stdout));
    if (!version) {
      return { error: 'git returned an unrecognized version string', ok: false };
    }
    if (!isAtLeastGit236(version)) {
      return {
        error: `Git 2.36 or newer is required for repository and worktree browsing; found ${version.join('.')}`,
        ok: false,
      };
    }
    return { ok: true, value: null };
  }

  async function requireFullWorktreeRoot(action: string): Promise<GitResult<null>> {
    const root = await resolveWorktreeRoot();
    if (!root.ok) {
      return root;
    }
    const [openedReal, worktreeReal] = await Promise.all([realpath(cwd), realpath(root.value)]);
    if (openedReal !== worktreeReal) {
      return {
        error: `${action} requires the full Git worktree root to be opened`,
        ok: false,
      };
    }
    return { ok: true, value: null };
  }

  async function listRemoteNames(): Promise<GitResult<readonly string[]>> {
    const run_ = await invoke(['remote']);
    if (run_.exitCode !== 0) {
      return { error: describeFailure(run_), ok: false };
    }
    const remotes = splitLineRecords(run_.stdout)
      .filter((remote) => remote.length > 0)
      .sort((left, right) => left.localeCompare(right));
    return { ok: true, value: remotes };
  }

  async function requireRemote(remote: unknown): Promise<GitResult<string>> {
    if (typeof remote !== 'string' || remote.length === 0) {
      return { error: 'remote must be a non-empty string', ok: false };
    }
    const remotes = await listRemoteNames();
    if (!remotes.ok) {
      return remotes;
    }
    if (!remotes.value.includes(remote)) {
      return { error: `remote "${remote}" does not exist`, ok: false };
    }
    return { ok: true, value: remote };
  }

  async function assertCommitScope(): Promise<GitResult<null>> {
    const [allRun, scopedRun] = await Promise.all([
      invoke(['diff', '--cached', '--name-only', '--no-renames', '-z']),
      invoke(['diff', '--cached', '--name-only', '--no-renames', '-z', '--', '.']),
    ]);
    if (allRun.exitCode !== 0) {
      return { error: describeFailure(allRun), ok: false };
    }
    if (scopedRun.exitCode !== 0) {
      return { error: describeFailure(scopedRun), ok: false };
    }
    const scopedPaths = new Set(scopedRun.stdout.split('\0').filter(Boolean));
    const outsidePaths = allRun.stdout
      .split('\0')
      .filter(Boolean)
      .filter((filePath) => !scopedPaths.has(filePath));
    if (outsidePaths.length > 0) {
      const preview = outsidePaths.slice(0, 3).join(', ');
      return {
        error: `Cannot commit: ${outsidePaths.length} staged path${outsidePaths.length === 1 ? '' : 's'} outside the opened folder (${preview})`,
        ok: false,
      };
    }
    return { ok: true, value: null };
  }

  function buildCommitArgs(params: {
    summary: string;
    description?: string | undefined;
  }): GitResult<string[]> {
    if (typeof params.summary !== 'string' || params.summary.trim().length === 0) {
      return { error: 'commit summary must be a non-empty string', ok: false };
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      return { error: 'commit description must be a string', ok: false };
    }
    const args = ['commit', '-m', params.summary.trim()];
    const description = params.description?.trim() ?? '';
    if (description.length > 0) {
      args.push('-m', description);
    }
    return { ok: true, value: args };
  }

  async function resolveCreatedCommit(): Promise<GitResult<GitCommitResult>> {
    const hashRun = await invoke(['rev-parse', '--short', 'HEAD']);
    if (hashRun.exitCode !== 0) {
      return {
        error: `commit created but resolving its hash failed: ${describeFailure(hashRun)}`,
        ok: false,
      };
    }
    const branchRun = await invoke(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branchRun.exitCode !== 0) {
      return {
        error: `commit created but resolving its branch failed: ${describeFailure(branchRun)}`,
        ok: false,
      };
    }
    const branchName = branchRun.stdout.trim();
    return {
      ok: true,
      value: {
        branch: branchName.length > 0 && branchName !== 'HEAD' ? branchName : null,
        commit: hashRun.stdout.trim(),
      },
    };
  }

  interface BranchTracking {
    readonly branch: string | null;
    readonly upstream: string | null;
  }

  async function resolveBranchTracking(): Promise<GitResult<BranchTracking>> {
    const branchRun = await invoke(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branchRun.exitCode === 1) {
      return { ok: true, value: { branch: null, upstream: null } };
    }
    if (branchRun.exitCode !== 0) {
      return { error: describeFailure(branchRun), ok: false };
    }
    const branch = branchRun.stdout.trim();
    if (branch.length === 0) {
      return { error: 'git returned an empty current branch name', ok: false };
    }
    const upstreamRun = await invoke([
      'for-each-ref',
      '--format=%(upstream:short)',
      `refs/heads/${branch}`,
    ]);
    if (upstreamRun.exitCode !== 0) {
      return { error: describeFailure(upstreamRun), ok: false };
    }
    return {
      ok: true,
      value: { branch, upstream: upstreamRun.stdout.trim() || null },
    };
  }

  async function resolvePushArgs(remote: unknown): Promise<GitResult<readonly string[]>> {
    const tracking = await resolveBranchTracking();
    if (!tracking.ok) {
      return tracking;
    }
    if (tracking.value.branch === null) {
      return { error: 'push requires a checked-out local branch', ok: false };
    }
    if (tracking.value.upstream !== null) {
      return { ok: true, value: ['push'] };
    }
    if (typeof remote !== 'string' || remote.length === 0) {
      return { error: 'first push requires an explicit remote', ok: false };
    }
    const configuredRemote = await requireRemote(remote);
    if (!configuredRemote.ok) {
      return configuredRemote;
    }
    return { ok: true, value: ['push', '-u', '--', configuredRemote.value, 'HEAD'] };
  }

  interface RepositoryInventory {
    readonly branches: readonly GitBranchSummary[];
    readonly currentBranch: string | null;
    readonly currentWorktree: GitWorktreeSummary;
    readonly remotes: readonly string[];
    readonly repositoryRoot: string;
    readonly worktreeRoot: string;
    readonly worktrees: readonly GitWorktreeSummary[];
  }

  async function loadRepositoryInventory(): Promise<GitResult<RepositoryInventory>> {
    const compatible = await requireNulSafeWorktreeInventory();
    if (!compatible.ok) {
      return compatible;
    }
    const root = await resolveWorktreeRoot();
    if (!root.ok) {
      return root;
    }
    const [worktreeRun, branchRun, remotes] = await Promise.all([
      invoke(['worktree', 'list', '--porcelain', '-z']),
      invoke([
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00',
        'refs/heads',
      ]),
      listRemoteNames(),
    ]);
    if (worktreeRun.exitCode !== 0) {
      return { error: describeFailure(worktreeRun), ok: false };
    }
    if (branchRun.exitCode !== 0) {
      return { error: describeFailure(branchRun), ok: false };
    }
    if (!remotes.ok) {
      return remotes;
    }
    const worktrees = parseWorktreeSummaries(worktreeRun.stdout, root.value);
    const currentWorktree = worktrees.find((worktree) => worktree.current);
    if (!currentWorktree) {
      return { error: 'git worktree inventory omitted the current worktree', ok: false };
    }
    const repositoryRoot = worktrees[0]?.path;
    if (!repositoryRoot) {
      return { error: 'git worktree inventory omitted the repository root', ok: false };
    }
    const branches = parseBranchSummaries(branchRun.stdout).map((branch) => ({
      ...branch,
      worktreePath: worktrees.find((worktree) => worktree.branch === branch.name)?.path ?? null,
    }));
    return {
      ok: true,
      value: {
        branches,
        currentBranch: branches.find((branch) => branch.current)?.name ?? null,
        currentWorktree,
        remotes: remotes.value,
        repositoryRoot,
        worktreeRoot: root.value,
        worktrees,
      },
    };
  }

  async function resolveDefaultRemote(
    currentBranch: string | null,
    remotes: readonly string[]
  ): Promise<GitResult<string | null>> {
    if (currentBranch === null) {
      return { ok: true, value: null };
    }
    const remoteRun = await invoke(['config', '--get', `branch.${currentBranch}.remote`]);
    if (remoteRun.exitCode === 1) {
      return { ok: true, value: null };
    }
    if (remoteRun.exitCode !== 0) {
      return { error: describeFailure(remoteRun), ok: false };
    }
    const configured = stripLineEnding(remoteRun.stdout);
    if (configured === '.') {
      return { ok: true, value: null };
    }
    if (!remotes.includes(configured)) {
      return { error: `current branch names unknown remote "${configured}"`, ok: false };
    }
    return { ok: true, value: configured };
  }

  /**
   * The three facts a forge lookup needs, in one pass: the realpath'd common
   * dir (repository identity), the checked-out branch (null when detached),
   * and the default remote's URL.
   *
   * `remoteReason` is non-null exactly when `remoteUrl` is null, so the caller
   * can SAY why there is no PR chip instead of showing nothing.
   */
  async function forgeRepositoryContext(): Promise<GitResult<GitForgeRepositoryContext>> {
    const commonDirRun = await invoke(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (commonDirRun.exitCode !== 0) {
      return { error: describeFailure(commonDirRun), ok: false };
    }
    const rawCommonDir = stripLineEnding(commonDirRun.stdout);
    if (rawCommonDir.length === 0) {
      return { error: 'git returned an empty git common dir', ok: false };
    }
    // Neither await depends on the other's result — realpath resolves the
    // already-known rawCommonDir, and the symbolic-ref spawn reads HEAD —
    // so they run concurrently instead of back-to-back.
    const [commonDir, headRun] = await Promise.all([
      realpath(rawCommonDir),
      invoke(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    ]);
    if (headRun.exitCode !== 0 && headRun.exitCode !== 1) {
      return { error: describeFailure(headRun), ok: false };
    }
    const branch = headRun.exitCode === 0 ? stripLineEnding(headRun.stdout) || null : null;
    const remotes = await listRemoteNames();
    if (!remotes.ok) {
      return remotes;
    }
    const configured = await resolveDefaultRemote(branch, remotes.value);
    if (!configured.ok) {
      return {
        ok: true,
        value: { branch, commonDir, remoteReason: configured.error, remoteUrl: null },
      };
    }
    const remoteName = resolveForgeRemoteName({
      configuredRemote: configured.value,
      remotes: remotes.value,
    });
    if (!remoteName.ok) {
      return {
        ok: true,
        value: { branch, commonDir, remoteReason: remoteName.reason, remoteUrl: null },
      };
    }
    const urlRun = await invoke(['remote', 'get-url', remoteName.value]);
    if (urlRun.exitCode !== 0) {
      return {
        ok: true,
        value: {
          branch,
          commonDir,
          remoteReason: `git could not read the URL of remote "${remoteName.value}": ${describeFailure(urlRun)}`,
          remoteUrl: null,
        },
      };
    }
    const remoteUrl = stripLineEnding(urlRun.stdout);
    if (remoteUrl.length === 0) {
      // `remoteReason` is non-null exactly when `remoteUrl` is null (see the
      // doc comment above): a successful exit with empty stdout must still
      // be treated as a stated failure, not silently paired with
      // `remoteUrl: ''` — that pairing would violate the invariant and send
      // an empty string into `parseForgeRemote` as `unparsable-remote`.
      return {
        ok: true,
        value: {
          branch,
          commonDir,
          remoteReason: `git returned an empty URL for remote "${remoteName.value}"`,
          remoteUrl: null,
        },
      };
    }
    return {
      ok: true,
      value: {
        branch,
        commonDir,
        remoteReason: null,
        remoteUrl,
      },
    };
  }

  async function createRepositorySnapshot(): Promise<GitResult<GitRepository>> {
    const inventory = await loadRepositoryInventory();
    if (!inventory.ok) {
      return inventory;
    }
    const defaultRemote = await resolveDefaultRemote(
      inventory.value.currentBranch,
      inventory.value.remotes
    );
    if (!defaultRemote.ok) {
      return defaultRemote;
    }
    const [openedReal, worktreeReal] = await Promise.all([
      realpath(cwd),
      realpath(inventory.value.worktreeRoot),
    ]);
    return {
      ok: true,
      value: {
        branches: inventory.value.branches,
        currentWorktree: inventory.value.currentWorktree,
        defaultRemote: defaultRemote.value,
        name: path.basename(inventory.value.repositoryRoot),
        openedRoot: openedReal,
        remotes: inventory.value.remotes,
        repositoryRoot: inventory.value.repositoryRoot,
        scope: openedReal === worktreeReal ? 'repository' : 'workspace',
        worktrees: inventory.value.worktrees,
      },
    };
  }

  const structuredDiffOps = createStructuredDiffOps({ cwd, invoke, invokeHookFree });
  const historyOps = createHistoryOps({ invoke });

  return {
    /** Ahead/behind counts vs the upstream tracking ref. */
    aheadBehind: async (): Promise<GitResult<GitAheadBehind>> => {
      try {
        const tracking = await resolveBranchTracking();
        if (!tracking.ok) {
          return tracking;
        }
        if (tracking.value.upstream === null) {
          return {
            ok: true,
            value: { ahead: null, behind: null, hasUpstream: false, upstream: null },
          };
        }
        const countRun = await invoke([
          'rev-list',
          '--left-right',
          '--count',
          'HEAD...@{upstream}',
        ]);
        if (countRun.exitCode !== 0) {
          return { error: describeFailure(countRun), ok: false };
        }
        // Output is "<ahead>\t<behind>".
        const [aheadRaw, behindRaw] = countRun.stdout.trim().split(/\s+/);
        const ahead = Number.parseInt(aheadRaw ?? '', 10);
        const behind = Number.parseInt(behindRaw ?? '', 10);
        return {
          ok: true,
          value: {
            ahead: Number.isNaN(ahead) ? null : ahead,
            behind: Number.isNaN(behind) ? null : behind,
            hasUpstream: true,
            upstream: tracking.value.upstream,
          },
        };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /**
     * Commit staged changes with a required summary and optional description.
     * Each paragraph is passed as its own literal `-m <value>` argument, so
     * shell metacharacters are inert commit content, never executed.
     */
    commit: async (params: {
      summary: string;
      description?: string | undefined;
    }): Promise<GitResult<GitCommitResult>> => {
      try {
        const args = buildCommitArgs(params);
        if (!args.ok) {
          return args;
        }
        const scope = await assertCommitScope();
        if (!scope.ok) {
          return scope;
        }
        const run_ = await invokeHookFree(args.value);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return await resolveCreatedCommit();
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /**
     * File list for a historical commit, scoped to the opened workspace root
     * — implemented in `git-history.ts`; see `createHistoryOps`.
     */
    commitFiles: historyOps.commitFiles,

    /** Create a new local branch at `startPoint` and check it out in this worktree. */
    createBranch: async (params: {
      branch: string;
      startPoint?: string;
    }): Promise<GitResult<GitCreateBranchResult>> => {
      try {
        if (typeof params.branch !== 'string' || params.branch.length === 0) {
          return { error: 'branch must be a non-empty string', ok: false };
        }
        if (params.branch === '-') {
          return { error: 'local branch "-" is not supported', ok: false };
        }
        const startPoint = params.startPoint;
        if (
          startPoint !== undefined &&
          (typeof startPoint !== 'string' || startPoint.length === 0)
        ) {
          return { error: 'startPoint must be a non-empty string when supplied', ok: false };
        }
        const scope = await requireFullWorktreeRoot('Branch creation');
        if (!scope.ok) {
          return scope;
        }
        const branch = params.branch;
        const exists = await invoke(['show-ref', '--verify', '--hash', `refs/heads/${branch}`]);
        if (exists.exitCode === 0) {
          // NEVER fall through to a plain switch: the caller asked to CREATE,
          // and quietly checking out an existing branch is a different action.
          return { error: `local branch "${branch}" already exists`, ok: false };
        }
        const run_ = await invokeHookFree([
          'switch',
          '--no-guess',
          '-c',
          branch,
          ...(startPoint ? ['--', startPoint] : []),
        ]);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return { ok: true, value: { branch } };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /**
     * Unified diff for a path (or the whole tree), optionally for the index.
     *
     * In untracked mode, a plain `git diff` reports
     * nothing (the file is not in the index), so the reviewer would see an empty
     * diff for a file that clearly has content. In that case we diff the new file
     * against `/dev/null` with `git diff --no-index`, which renders the whole
     * file as additions. `--no-index` intentionally exits 1 when the inputs
     * differ — that is the normal "there is a diff" outcome, NOT a failure.
     */
    diff: async (params: GitDiffParams): Promise<GitResult<GitDiff>> => {
      try {
        const validated = validateDiffParams(params);
        if (!validated.ok) {
          return validated;
        }
        const staged = validated.value.mode === 'staged';
        const untracked = validated.value.mode === 'untracked';
        const pathResult = resolveContainedPathArg(cwd, validated.value.path);
        if (!pathResult.ok) {
          return pathResult;
        }
        const pathArg = pathResult.value;

        const args: string[] = ['diff', '--no-ext-diff', '--no-textconv'];
        if (untracked && pathArg !== null) {
          // SECURITY: --no-index reads the filesystem, so a symlinked path could
          // escape the opened folder. Verify real-path containment before git.
          const containment = await assertUntrackedDiffPathContained(cwd, pathArg);
          if (!containment.ok) {
            return containment;
          }
          // Whole-file additions for a new, untracked file.
          args.push('--no-index', '--', '/dev/null', pathArg);
        } else {
          if (staged) {
            args.push('--cached');
          }
          // `--` terminates options so a path that looks like a flag can never be
          // parsed as one. Scope to the opened root ('.') when no path is given so
          // a root that is a SUBDIR of a larger worktree never diffs siblings.
          args.push('--', pathArg ?? '.');
        }

        const run_ = await (untracked ? invoke : invokeHookFree)(args);
        // An oversized diff overflows `maxBuffer` (failureReason 'maxBuffer'):
        // the partial stdout is still a valid prefix of the diff, so bound it and
        // report a `truncated: true` SUCCESS rather than a failure. With
        // `--no-index`, exit code 1 means "files differ" (expected success).
        const failure = describeDiffFailure(run_, untracked);
        if (failure) {
          return { error: failure, ok: false };
        }
        const overflowed = run_.failureReason === 'maxBuffer';
        const bounded = boundOutput(run_.stdout);
        return {
          ok: true,
          value: {
            path: pathArg,
            staged,
            truncated: bounded.truncated || overflowed,
            unifiedDiff: bounded.text,
          },
        };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /** Fetch one explicit, configured remote without integrating changes. */
    fetch: async (params: { remote: string }): Promise<GitResult<GitPushPullResult>> => {
      try {
        const remote = await requireRemote(params.remote);
        if (!remote.ok) {
          return remote;
        }
        const run_ = await invokeHookFree(
          ['fetch', '--prune', '--', remote.value],
          GIT_NETWORK_TIMEOUT_MS
        );
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        const bounded = boundOutput(`${run_.stdout}${run_.stderr}`.trim());
        return { ok: true, value: { output: bounded.text } };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /** Repository identity + branch + default-remote URL for forge lookups. */
    forgeRepositoryContext,

    /** Paginated, summary-only history for HEAD, a local branch, or a returned OID. */
    history: historyOps.history,

    /** Pull (fetch + merge) from the upstream remote (network op). */
    pull: async (): Promise<GitResult<GitPushPullResult>> => {
      try {
        const scope = await requireFullWorktreeRoot('Pull');
        if (!scope.ok) {
          return scope;
        }
        const run_ = await invokeHookFree(['pull'], GIT_NETWORK_TIMEOUT_MS);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        const bounded = boundOutput(`${run_.stdout}${run_.stderr}`.trim());
        return { ok: true, value: { output: bounded.text } };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /**
     * Push to the upstream remote (network op, longer timeout).
     *
     * When the current branch has NO upstream, the caller must choose a
     * configured remote explicitly. The service never guesses `origin`.
     */
    push: async (
      params: { remote?: string | undefined } = {}
    ): Promise<GitResult<GitPushPullResult>> => {
      try {
        const scope = await requireFullWorktreeRoot('Push');
        if (!scope.ok) {
          return scope;
        }
        const args = await resolvePushArgs(params.remote);
        if (!args.ok) {
          return args;
        }
        const run_ = await invokeHookFree(args.value, GIT_NETWORK_TIMEOUT_MS);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        const bounded = boundOutput(`${run_.stdout}${run_.stderr}`.trim());
        return { ok: true, value: { output: bounded.text } };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /** Repository/worktree/branch identity. Worktree paths are metadata only. */
    repository: async (): Promise<GitResult<GitRepository>> => {
      try {
        return await createRepositorySnapshot();
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /** Stage a path (or all changes within the opened root): `git add`. */
    stage: async (params: { path?: string | undefined }): Promise<GitResult<null>> => {
      try {
        const pathResult = resolveContainedPathArg(cwd, params.path);
        if (!pathResult.ok) {
          return pathResult;
        }
        // No path → scope to the opened root ('.'), never the whole worktree.
        const run_ = await invokeHookFree(['add', '--', pathResult.value ?? '.']);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return { ok: true, value: null };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
    /** Porcelain status + branch + ahead/behind, parsed into a typed structure. */
    status: async (): Promise<GitResult<GitStatus>> => {
      try {
        // Scope to the opened root ('-- .') so a root that is a SUBDIR of a
        // larger worktree reports only its own changes — never sibling paths
        // like `../other/file` that could then be passed back to diff/stage and
        // escape the opened folder. `--branch` still yields the repo-wide branch
        // header (ahead/behind), which is what the meter wants.
        const [run_, prefixRun] = await Promise.all([
          invoke([
            '-c',
            'core.fsmonitor=false',
            'status',
            '--porcelain=v2',
            '--branch',
            '--untracked-files=all',
            '-z',
            '--',
            '.',
          ]),
          invoke(['rev-parse', '--show-prefix']),
        ]);
        if (run_.exitCode !== 0) {
          if (isNotARepository(run_)) {
            // A non-repo (or web FSA root) is a clean, EXPECTED state — not an
            // error. The caller renders "not a git repo", no crash.
            return {
              ok: true,
              value: {
                ahead: null,
                behind: null,
                branch: null,
                clean: true,
                files: [],
                isRepository: false,
                upstream: null,
              },
            };
          }
          return { error: describeFailure(run_), ok: false };
        }
        if (prefixRun.exitCode !== 0) {
          return { error: describeFailure(prefixRun), ok: false };
        }
        const parsed = scopeStatusPaths(
          parsePorcelainV2Z(run_.stdout),
          stripLineEnding(prefixRun.stdout)
        );
        if (!parsed.ok) {
          return parsed;
        }
        return {
          ok: true,
          value: { isRepository: true, ...parsed.value },
        };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /**
     * Both-sides file content + structured hunk ranges for one path (spec §3,
     * §11 Q3) — the `StructuredFileDiff` replacement for the unified-diff-string
     * `diff()` contract. `mode` selects the comparison: `working` (HEAD vs.
     * worktree, i.e. all uncommitted changes), `staged` (HEAD vs. index), or
     * `untracked` (no HEAD/index side at all). Implemented in
     * `git-structured-diff.ts`; see `createStructuredDiffOps`.
     */
    structuredFileDiff: structuredDiffOps.structuredFileDiff,

    /** Switch the full opened worktree to an existing local branch. */
    switchBranch: async (params: { branch: string }): Promise<GitResult<GitSwitchBranchResult>> => {
      try {
        if (typeof params.branch !== 'string' || params.branch.length === 0) {
          return { error: 'branch must be a non-empty string', ok: false };
        }
        if (params.branch === '-') {
          return { error: 'local branch "-" is not supported', ok: false };
        }
        const scope = await requireFullWorktreeRoot('Branch switching');
        if (!scope.ok) {
          return scope;
        }
        const branch = params.branch;
        const exists = await invoke(['show-ref', '--verify', '--hash', `refs/heads/${branch}`]);
        if (exists.exitCode !== 0) {
          return { error: `local branch "${branch}" does not exist`, ok: false };
        }
        const run_ = await invokeHookFree(['switch', '--no-guess', '--', branch]);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return { ok: true, value: { branch } };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },

    /** Unstage a path (or all within the opened root): `git restore --staged`. */
    unstage: async (params: { path?: string | undefined }): Promise<GitResult<null>> => {
      try {
        const pathResult = resolveContainedPathArg(cwd, params.path);
        if (!pathResult.ok) {
          return pathResult;
        }
        const run_ = await invokeHookFree(['restore', '--staged', '--', pathResult.value ?? '.']);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return { ok: true, value: null };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
