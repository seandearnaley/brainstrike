/**
 * Pure, dependency-injected git operations for the desktop `git` IPC domain.
 *
 * This module has NO Electron imports so it is hermetically testable against a
 * real temp git repository (see `git-service.test.ts`). It exposes a small set
 * of typed operations — status / diff / stage / unstage / commit / push / pull /
 * ahead-behind — each of which:
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
 */

export const GIT_DEFAULT_TIMEOUT_MS = 30_000;
/** Push / pull can hang on auth or a slow network — give them a longer leash. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;
/** Hard ceiling on captured stdout/stderr per git invocation (bytes). */
export const GIT_MAX_OUTPUT_BYTES = 1_000_000;

/** Result of running a single `git` invocation through the injected runner. */
export interface GitCommandRun {
  /** Process exit code, or null when terminated by a signal (timeout). */
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
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
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}) => Promise<GitCommandRun>;

/** Discriminated result envelope returned across the IPC boundary. */
export type GitResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A single changed path in the working tree / index. */
export interface GitStatusFile {
  /** Original path for a rename/copy, else undefined. */
  readonly originalPath?: string;
  /** POSIX-ish path relative to the repo root, as git reports it. */
  readonly path: string;
  /** True when the index differs from HEAD for this path (staged change). */
  readonly staged: boolean;
  /** Single-letter status (M, A, D, R, C, U, ?, !) for the relevant side. */
  readonly status: string;
  /** True when the working tree differs from the index (unstaged change). */
  readonly unstaged: boolean;
  /** True for an untracked path (`?`). */
  readonly untracked: boolean;
}

export interface GitStatus {
  /** Commits HEAD is ahead of its upstream, or null if no upstream. */
  readonly ahead: number | null;
  /** Commits the upstream is ahead of HEAD (HEAD is behind), or null if none/unknown. */
  readonly behind: number | null;
  /** Current branch name, or null on a detached HEAD. */
  readonly branch: string | null;
  /** True when the working tree + index are clean. */
  readonly clean: boolean;
  /** Changed paths (staged, unstaged, untracked, renamed). */
  readonly files: readonly GitStatusFile[];
  /** True when `cwd` is not inside a git work tree. */
  readonly isRepository: boolean;
  /** Upstream tracking ref (e.g. `origin/main`), or null if none. */
  readonly upstream: string | null;
}

export interface GitDiff {
  /** The path the diff was scoped to, or null for a whole-tree diff. */
  readonly path: string | null;
  /** True when the diff was for the staged (index vs HEAD) view. */
  readonly staged: boolean;
  /** True when the unified diff text was trimmed to the size budget. */
  readonly truncated: boolean;
  /** Unified diff text (bounded to {@link GIT_MAX_OUTPUT_BYTES}). */
  readonly unifiedDiff: string;
}

export interface GitAheadBehind {
  /** Commits HEAD is ahead of its upstream, or null when there is no upstream. */
  readonly ahead: number | null;
  /** Commits HEAD is behind its upstream, or null when there is no upstream. */
  readonly behind: number | null;
  /** True when an upstream tracking ref is configured. */
  readonly hasUpstream: boolean;
  /** Upstream tracking ref (e.g. `origin/main`), or null if none. */
  readonly upstream: string | null;
}

export interface GitCommitResult {
  /** Branch the commit landed on (best-effort; may be null on detached HEAD). */
  readonly branch: string | null;
  /** Short commit hash of the new commit. */
  readonly commit: string;
}

export interface GitPushPullResult {
  /** Combined human-readable output git emitted (bounded). */
  readonly output: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bound a captured stream to the size budget, keeping the head (where git's
 * summary / errors lead) plus a truncation marker. */
function boundOutput(text: string): { text: string; truncated: boolean } {
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
 * Never silent: if both streams are empty we still report the exit code.
 */
function describeFailure(run: GitCommandRun): string {
  if (run.timedOut) {
    return 'git command timed out';
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
      unstaged,
      untracked: false,
      status: staged ? stagedCode : unstagedCode,
    };
  }
  return {
    path: pathPortion,
    staged,
    unstaged,
    untracked: false,
    status: staged ? stagedCode : unstagedCode,
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
      unstaged: false,
      untracked: true,
      status: '?',
    };
  }
  if (line.startsWith('u ')) {
    // Unmerged: path begins after the 10 fixed header columns.
    const pathPortion = line.split(' ').slice(10).join(' ');
    if (pathPortion.length > 0) {
      return { path: pathPortion, staged: true, unstaged: true, untracked: false, status: 'U' };
    }
  }
  return null;
}

/**
 * Parse `git status --porcelain=v2 --branch` output into a {@link GitStatus}.
 * Pure and exported for direct unit testing.
 */
export function parsePorcelainV2(stdout: string): Omit<GitStatus, 'isRepository'> {
  const header: BranchHeader = { branch: null, upstream: null, ahead: null, behind: null };
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
    branch: header.branch,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    clean: files.length === 0,
    files,
  };
}

/** Validate that a model/renderer-supplied path arg is a safe relative-ish path. */
function assertSafePathArg(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  return trimmed;
}

export interface GitServiceOptions {
  readonly cwd: string;
  readonly run: GitCommandRunner;
  readonly signal?: AbortSignal | undefined;
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
    timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS
  ): Promise<GitCommandRun> {
    return await run({ args, cwd, signal, timeoutMs });
  }

  return {
    /** Porcelain status + branch + ahead/behind, parsed into a typed structure. */
    status: async (): Promise<GitResult<GitStatus>> => {
      try {
        const run_ = await invoke(['status', '--porcelain=v2', '--branch']);
        if (run_.exitCode !== 0) {
          if (isNotARepository(run_)) {
            // A non-repo (or web FSA root) is a clean, EXPECTED state — not an
            // error. The caller renders "not a git repo", no crash.
            return {
              ok: true,
              value: {
                isRepository: false,
                branch: null,
                upstream: null,
                ahead: null,
                behind: null,
                clean: true,
                files: [],
              },
            };
          }
          return { ok: false, error: describeFailure(run_) };
        }
        return {
          ok: true,
          value: { isRepository: true, ...parsePorcelainV2(run_.stdout) },
        };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    /** Unified diff for a path (or the whole tree), optionally for the index. */
    diff: async (params: {
      path?: string | undefined;
      staged?: boolean | undefined;
    }): Promise<GitResult<GitDiff>> => {
      try {
        const staged = params.staged === true;
        const args = ['diff'];
        if (staged) {
          args.push('--cached');
        }
        const pathArg = params.path ? assertSafePathArg(params.path) : null;
        if (pathArg) {
          // `--` terminates options so a path that looks like a flag (or starts
          // with `-`) can never be parsed as one.
          args.push('--', pathArg);
        }
        const run_ = await invoke(args);
        if (run_.exitCode !== 0) {
          return { ok: false, error: describeFailure(run_) };
        }
        const bounded = boundOutput(run_.stdout);
        return {
          ok: true,
          value: {
            staged,
            path: pathArg,
            unifiedDiff: bounded.text,
            truncated: bounded.truncated,
          },
        };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    /** Stage a path (or all changes when no path is given): `git add`. */
    stage: async (params: { path?: string | undefined }): Promise<GitResult<null>> => {
      try {
        const pathArg = params.path ? assertSafePathArg(params.path) : '.';
        const run_ = await invoke(['add', '--', pathArg]);
        if (run_.exitCode !== 0) {
          return { ok: false, error: describeFailure(run_) };
        }
        return { ok: true, value: null };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    /** Unstage a path (or all): `git restore --staged`. */
    unstage: async (params: { path?: string | undefined }): Promise<GitResult<null>> => {
      try {
        const pathArg = params.path ? assertSafePathArg(params.path) : '.';
        const run_ = await invoke(['restore', '--staged', '--', pathArg]);
        if (run_.exitCode !== 0) {
          return { ok: false, error: describeFailure(run_) };
        }
        return { ok: true, value: null };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    /**
     * Commit the staged changes with `message`. The message is passed as a
     * single `execFile` argument (`-m <message>`), so shell metacharacters in it
     * are inert — they become the literal commit message, never executed.
     */
    commit: async (params: { message: string }): Promise<GitResult<GitCommitResult>> => {
      try {
        const message = params.message;
        if (typeof message !== 'string' || message.trim().length === 0) {
          return { ok: false, error: 'commit message must be a non-empty string' };
        }
        const run_ = await invoke(['commit', '-m', message]);
        if (run_.exitCode !== 0) {
          return { ok: false, error: describeFailure(run_) };
        }
        // Resolve the new commit hash + branch without re-parsing porcelain noise.
        const hashRun = await invoke(['rev-parse', '--short', 'HEAD']);
        const branchRun = await invoke(['rev-parse', '--abbrev-ref', 'HEAD']);
        const commit = hashRun.exitCode === 0 ? hashRun.stdout.trim() : '';
        const branchName = branchRun.exitCode === 0 ? branchRun.stdout.trim() : '';
        return {
          ok: true,
          value: {
            commit,
            branch: branchName.length > 0 && branchName !== 'HEAD' ? branchName : null,
          },
        };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    /** Ahead/behind counts vs the upstream tracking ref. */
    aheadBehind: async (): Promise<GitResult<GitAheadBehind>> => {
      try {
        // `@{upstream}` errors with exit 128 when no upstream is set — that is a
        // valid state, not a failure.
        const upstreamRun = await invoke([
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          '@{upstream}',
        ]);
        if (upstreamRun.exitCode !== 0) {
          return {
            ok: true,
            value: { hasUpstream: false, upstream: null, ahead: null, behind: null },
          };
        }
        const upstream = upstreamRun.stdout.trim() || null;
        const countRun = await invoke([
          'rev-list',
          '--left-right',
          '--count',
          'HEAD...@{upstream}',
        ]);
        if (countRun.exitCode !== 0) {
          return { ok: false, error: describeFailure(countRun) };
        }
        // Output is "<ahead>\t<behind>".
        const [aheadRaw, behindRaw] = countRun.stdout.trim().split(/\s+/);
        const ahead = Number.parseInt(aheadRaw ?? '', 10);
        const behind = Number.parseInt(behindRaw ?? '', 10);
        return {
          ok: true,
          value: {
            hasUpstream: true,
            upstream,
            ahead: Number.isNaN(ahead) ? null : ahead,
            behind: Number.isNaN(behind) ? null : behind,
          },
        };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    /** Push to the upstream remote (network op, longer timeout). */
    push: async (): Promise<GitResult<GitPushPullResult>> => {
      try {
        const run_ = await invoke(['push'], GIT_NETWORK_TIMEOUT_MS);
        if (run_.exitCode !== 0) {
          return { ok: false, error: describeFailure(run_) };
        }
        const bounded = boundOutput(`${run_.stdout}${run_.stderr}`.trim());
        return { ok: true, value: { output: bounded.text } };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },

    /** Pull (fetch + merge) from the upstream remote (network op). */
    pull: async (): Promise<GitResult<GitPushPullResult>> => {
      try {
        const run_ = await invoke(['pull'], GIT_NETWORK_TIMEOUT_MS);
        if (run_.exitCode !== 0) {
          return { ok: false, error: describeFailure(run_) };
        }
        const bounded = boundOutput(`${run_.stdout}${run_.stderr}`.trim());
        return { ok: true, value: { output: bounded.text } };
      } catch (error) {
        return { ok: false, error: toErrorMessage(error) };
      }
    },
  };
}
