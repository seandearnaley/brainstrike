/**
 * Low-level shadow-git plumbing for the W7 snapshot engine (BST-1164 T0).
 *
 * A "shadow" repository is a git dir that lives OUTSIDE the workspace root
 * (under the caller's snapshots base dir) while using the user's folder as its
 * work-tree. The user's own `.git` — index, HEAD, refs, stash, hooks — is
 * NEVER touched: every command runs `--git-dir=<shadow> --work-tree=<root>`
 * with a PRIVATE `GIT_INDEX_FILE` per operation (a temp file inside the
 * shadow git dir, removed afterwards), so no state of the user's repository
 * is read or written, and two concurrent operations can never share an index.
 *
 * Follows `git-service.ts`'s runner posture: git is invoked ONLY through an
 * injected runner (NEVER a shell — every argument is a
 * separate array element), the runner resolves (never rejects) with captured
 * streams + a discriminated failure reason, and output is bounded by the same
 * `GIT_MAX_BUFFER_BYTES` hard cap. Commands are routed through the house
 * `invokeGitHookFree` wrapper so `core.fsmonitor`, `core.hooksPath`, and
 * config-managed `hook.*.command` hooks are disabled at command scope on
 * every spawn (the probe inside that helper is the one documented exception).
 * An operation that runs several commands (a snapshot, initialization) reads
 * that probe once and gives each of its commands the same flags.
 *
 * RUNNER CONTRACT EXTENSION (deliberate, minimal): {@link SnapshotGitCommandParams}
 * is `git-service.ts`'s `GitCommandRunner` params plus an optional `env` of
 * EXTRA variables merged over the runner's pinned base environment. This is
 * not optional design surface — `GIT_INDEX_FILE` has NO command-line
 * equivalent (no `git --index-file` exists), so a private per-operation index
 * is impossible without env control. Because a plain `GitCommandRunner` is
 * structurally assignable here yet would IGNORE `env` (a silent-degradation
 * hazard), `verifyRunnerHonorsEnv` proves the injected runner actually
 * honors it before any shadow repo is used — a runner that does not is a
 * typed, thrown error, never a quiet fallback to the shared index.
 *
 * Unlike `git-service.ts` (which returns `{ ok:false }` results across an IPC
 * boundary), this module THROWS typed {@link SnapshotGitError}s: its callers
 * are in-process services that must fail operations visibly (plan global
 * constraint 4 — no silent fallbacks).
 *
 * CWD IS LOAD-BEARING (empirically confirmed against git 2.x, W7 T0): with an
 * explicit `--git-dir`, git still PREFIX-SCOPES worktree-relative commands to
 * the spawn cwd — `add -A` from a SUBDIRECTORY of the work-tree stages only
 * that subtree, and `ls-tree -r` silently filters its listing to the cwd's
 * prefix whenever the cwd sits below the repo's effective work-tree
 * (`core.worktree` is written by `git init --work-tree=…`, so this bites any
 * ad-hoc spawn, not just staging). That is why {@link createShadowGitPlumbing}
 * pins EVERY spawn's cwd to the root — never run shadow-git commands through
 * any other channel with a different cwd.
 */
import { createHash, randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { describeFailure } from './git-failure.ts';
import { execFileGitRunner } from './git-methods.ts';
import {
  type GitCommandRun,
  invokeGitHookFree,
  readGitHookFreeFlags,
  stripLineEnding,
} from './git-service.ts';
import { type DiffSide, STRUCTURED_DIFF_CONTENT_CAP_BYTES } from './structured-diff-content.ts';

/** Discriminated cause for every failure this module throws. */
export type SnapshotGitErrorCode =
  | 'git-command-failed'
  | 'inconsistent-diff'
  | 'invalid-argument'
  | 'root-unavailable'
  | 'runner-env-unsupported'
  | 'stale-handle';

export class SnapshotGitError extends Error {
  readonly code: SnapshotGitErrorCode;

  constructor(code: SnapshotGitErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SnapshotGitError';
  }
}

/**
 * `GitCommandRunner` params + the `env` extension (see the module doc
 * comment). `env` entries are merged OVER the runner's pinned base
 * environment; they never replace it wholesale.
 */
interface SnapshotGitCommandParams {
  readonly args: readonly string[];
  readonly binaryStdout?: boolean | undefined;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export type SnapshotGitCommandRunner = (params: SnapshotGitCommandParams) => Promise<GitCommandRun>;

/**
 * Snapshotting a large root hashes every file on the first pass — give local
 * plumbing a longer leash than interactive `GIT_DEFAULT_TIMEOUT_MS` (there is
 * no network in any shadow-git command).
 */
const SNAPSHOT_GIT_TIMEOUT_MS = 120_000;

/**
 * The production snapshot runner is the house git runner: argument array (no
 * shell), resolve-never-reject, bounded capture, and the pinned git environment
 * with the caller's `env` merged over it (`createGitCommandEnvironment`).
 */
export const execFileSnapshotGitRunner: SnapshotGitCommandRunner = execFileGitRunner;

const OID_PATTERN = /^[0-9a-f]{40,64}$/u;

/** Full hex object id — the engine never resolves symbolic refs from callers. */
export function assertValidOid(oid: string, label: string): void {
  if (!OID_PATTERN.test(oid)) {
    throw new SnapshotGitError('invalid-argument', `${label} must be a full hex object id`);
  }
}

// Root directories and legacy ref components retain their strict path validation.
// Native thread identities use a bounded encoded ref when they do not fit it.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertValidIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value) || value.includes('..') || value.endsWith('.lock')) {
    throw new SnapshotGitError(
      'invalid-argument',
      `${label} "${value}" is not a safe identifier (letters, digits, ".", "_", "-"; no "..")`
    );
  }
}

export function assertValidRootId(rootId: string): void {
  assertValidIdentifier(rootId, 'rootId');
}

/** A conversation identity is opaque data, not a path component. */
function assertValidThreadId(threadId: string): void {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new SnapshotGitError('invalid-argument', 'threadId must be a non-empty identity');
  }
}

export const LEGACY_SNAPSHOT_REF_PREFIX = 'refs/snapshots/';
export const ENCODED_SNAPSHOT_REF_PREFIX = 'refs/snapshot-identities/v1/';

/** Preserve existing lineage refs; other native identities receive a bounded key.
 * Exact identity stays in the existing commit metadata, never in a filesystem path. */
export function snapshotRefForThread(threadId: string): string {
  assertValidThreadId(threadId);
  if (
    IDENTIFIER_PATTERN.test(threadId) &&
    !threadId.includes('..') &&
    !threadId.endsWith('.lock') &&
    !threadId.endsWith('.')
  ) {
    return `${LEGACY_SNAPSHOT_REF_PREFIX}${threadId}`;
  }
  return `${ENCODED_SNAPSHOT_REF_PREFIX}${createHash('sha256').update(threadId).digest('hex')}`;
}

/** Shipped `info/exclude` backstop for non-git roots (plan global constraint 3). */
const SHADOW_INFO_EXCLUDE = 'node_modules/\n.DS_Store\n';

/**
 * The shadow repo's pinned config (plan global constraint 2 + deterministic
 * commit identity for `commit-tree`), appended to the config `git init` wrote
 * in one file write rather than one `git config` process per key. A key
 * `git init` already wrote (`core.filemode`) is overridden: git reads the last
 * value of a single-valued key.
 */
const SHADOW_PINNED_CONFIG = [
  '[core]',
  '\tautocrlf = false',
  '\tfilemode = false',
  '\tuntrackedCache = true',
  '[commit]',
  '\tgpgsign = false',
  '[advice]',
  '\taddEmbeddedRepo = false',
  '[user]',
  '\tname = BrainStrike Snapshots',
  '\temail = snapshots@brainstrike.local',
  '',
].join('\n');

/** Env-var record for a private index (env-var names are not camelCase). */
function gitIndexFileEnv(indexPath: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  env['GIT_INDEX_FILE'] = indexPath;
  return env;
}

/**
 * Exit-128 stderr wording for an ABSENT `cat-file` object spec. Mirrors
 * `git-structured-diff.ts`'s `CAT_FILE_ABSENT_STDERR_PATTERN` (not exported
 * there; T0 is barred from editing that file). Any other failure stays a hard
 * error — never classified as an absent side.
 */
const CAT_FILE_ABSENT_STDERR_PATTERN =
  /does not exist|exists on disk, but not in|invalid object name/u;

export interface ShadowGitInvokeOptions {
  readonly binaryStdout?: boolean | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/**
 * One operation's shadow commands. Each is hook-free under the flags of a
 * single probe read when the operation began, instead of a probe per command.
 */
export interface ShadowGitCommands {
  invoke(args: readonly string[], options?: ShadowGitInvokeOptions): Promise<GitCommandRun>;
  resolveRefOrNull(ref: string): Promise<string | null>;
  runOrThrow(args: readonly string[], options?: ShadowGitInvokeOptions): Promise<GitCommandRun>;
}

export interface ShadowGitPlumbingOptions {
  readonly gitDir: string;
  readonly rootPath: string;
  readonly runner: SnapshotGitCommandRunner;
}

/**
 * Build the shadow-git command helpers bound to one `(gitDir, rootPath)`
 * pair. Every command carries `--git-dir`/`--work-tree` explicitly and runs
 * with `cwd` pinned to the root, so git can never discover — let alone
 * mutate — the user's own repository.
 */
export function createShadowGitPlumbing({ gitDir, rootPath, runner }: ShadowGitPlumbingOptions) {
  async function invokeRaw(
    args: readonly string[],
    options?: ShadowGitInvokeOptions
  ): Promise<GitCommandRun> {
    return await runner({
      args: [`--git-dir=${gitDir}`, `--work-tree=${rootPath}`, ...args],
      binaryStdout: options?.binaryStdout,
      cwd: rootPath,
      env: options?.env,
      timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS,
    });
  }

  /** Commands over one hook-free invocation: a probe per command, or one shared probe. */
  function commandsOver(
    invoke: (args: readonly string[], options?: ShadowGitInvokeOptions) => Promise<GitCommandRun>
  ): ShadowGitCommands {
    /** Invoke and throw a typed error on any non-clean exit. */
    async function runOrThrow(
      args: readonly string[],
      options?: ShadowGitInvokeOptions
    ): Promise<GitCommandRun> {
      const run = await invoke(args, options);
      if (run.exitCode !== 0 || run.failureReason !== undefined) {
        throw new SnapshotGitError(
          'git-command-failed',
          `git ${args[0] ?? ''} failed for shadow repo at ${gitDir}: ${describeFailure(run)}`
        );
      }
      return run;
    }

    /**
     * Resolve a ref to its commit oid, or null when the ref does not exist.
     * Any other failure (corrupt repo, bad ref syntax) throws — absence is the
     * ONLY quiet outcome, and it is an explicit null, not a fallback.
     */
    async function resolveRefOrNull(ref: string): Promise<string | null> {
      const run = await invoke(['rev-parse', '--quiet', '--verify', ref]);
      if (run.exitCode === 0 && run.failureReason === undefined) {
        const oid = stripLineEnding(run.stdout);
        assertValidOid(oid, `resolved ref ${ref}`);
        return oid;
      }
      if (run.exitCode === 1 && run.failureReason === undefined) {
        return null;
      }
      throw new SnapshotGitError(
        'git-command-failed',
        `git rev-parse --verify ${ref} failed: ${describeFailure(run)}`
      );
    }

    return { invoke, resolveRefOrNull, runOrThrow };
  }

  /** Hook-free invocation (house pattern), probing before each command. */
  const { invoke, resolveRefOrNull, runOrThrow } = commandsOver(
    async (args, options) =>
      await invokeGitHookFree(
        (hookFreeArgs) => invokeRaw(hookFreeArgs, options),
        args,
        SNAPSHOT_GIT_TIMEOUT_MS
      )
  );

  /**
   * One operation's commands under a single hook probe, read now. Every
   * command still carries the same command-scope flags `invokeGitHookFree`
   * gives it; only the probe is shared, so a hook configured before the
   * operation starts never runs. A probe failure fails the operation.
   */
  async function hookFreeCommands(): Promise<ShadowGitCommands> {
    const probe = await readGitHookFreeFlags((args) => invokeRaw(args));
    if (!probe.ok) {
      throw new SnapshotGitError(
        'git-command-failed',
        `git config hook probe failed for shadow repo at ${gitDir}: ${describeFailure(probe.run)}`
      );
    }
    return commandsOver(
      async (args, options) => await invokeRaw([...probe.flags, ...args], options)
    );
  }

  /**
   * Run `task` with a private, per-operation `GIT_INDEX_FILE` inside the
   * shadow git dir. The index (and any transient `.lock`) is removed on the
   * way out regardless of outcome; nothing ever touches the shadow repo's
   * default `index`, let alone the user's.
   */
  async function withTempIndex<T>(
    task: (env: Readonly<Record<string, string>>, indexPath: string) => Promise<T>
  ): Promise<T> {
    const indexPath = path.join(gitDir, `index-${randomUUID()}.tmp`);
    try {
      return await task(gitIndexFileEnv(indexPath), indexPath);
    } finally {
      await fsPromises.rm(indexPath, { force: true });
      await fsPromises.rm(`${indexPath}.lock`, { force: true });
    }
  }

  /**
   * Prove the injected runner honors the `env` extension: `git rev-parse
   * --git-path index` reports the effective index path, which MUST be the
   * sentinel passed via `GIT_INDEX_FILE`. A runner that ignores `env` would
   * silently share one index across operations — refuse it up front.
   */
  async function verifyRunnerHonorsEnv(scoped: ShadowGitCommands): Promise<void> {
    const sentinel = path.join(gitDir, 'runner-env-probe-index');
    const run = await scoped.runOrThrow(['rev-parse', '--git-path', 'index'], {
      env: gitIndexFileEnv(sentinel),
    });
    if (stripLineEnding(run.stdout) !== sentinel) {
      throw new SnapshotGitError(
        'runner-env-unsupported',
        'the injected git runner does not honor per-command env (GIT_INDEX_FILE); ' +
          'shadow snapshots require an env-capable runner'
      );
    }
  }

  /**
   * Initialize the shadow git dir if absent: `git init` (HEAD stays unborn —
   * snapshots use their own ref namespaces, never a branch), the pinned
   * config, and the `info/exclude` backstop. Idempotent: an existing repo
   * (HEAD present) is left as-is. One hook probe covers its commands: the
   * config it writes adds no hooks.
   */
  async function ensureInitialized(): Promise<void> {
    const headPath = path.join(gitDir, 'HEAD');
    const headExists = await fsPromises.access(headPath).then(
      () => true,
      () => false
    );
    const scoped = await hookFreeCommands();
    if (!headExists) {
      await fsPromises.mkdir(path.dirname(gitDir), { recursive: true });
      await scoped.runOrThrow(['init', '-q']);
      await fsPromises.appendFile(path.join(gitDir, 'config'), SHADOW_PINNED_CONFIG, 'utf8');
      await fsPromises.mkdir(path.join(gitDir, 'info'), { recursive: true });
      await fsPromises.writeFile(path.join(gitDir, 'info', 'exclude'), SHADOW_INFO_EXCLUDE, 'utf8');
    }
    await verifyRunnerHonorsEnv(scoped);
  }

  /**
   * Size-gated blob read for one object spec (`<oid>:<path>` or `:0:<path>`
   * with the operation's index env). Probes `cat-file -s` first so an
   * over-cap side is never read; a `maxBuffer` overflow during the actual
   * read is a hard failure (a truncated blob is silent corruption — see
   * `GitCommandRun.stdoutBuffer`'s contract).
   */
  async function readBlobSized(spec: string, options?: ShadowGitInvokeOptions): Promise<DiffSide> {
    const sizeRun = await invoke(['cat-file', '-s', spec], options);
    if (sizeRun.exitCode !== 0 || sizeRun.failureReason !== undefined) {
      if (sizeRun.exitCode === 128 && CAT_FILE_ABSENT_STDERR_PATTERN.test(sizeRun.stderr)) {
        return { kind: 'absent' };
      }
      throw new SnapshotGitError(
        'git-command-failed',
        `git cat-file -s ${spec} failed: ${describeFailure(sizeRun)}`
      );
    }
    const size = Number.parseInt(sizeRun.stdout.trim(), 10);
    if (!Number.isFinite(size)) {
      throw new SnapshotGitError(
        'git-command-failed',
        `git returned a non-numeric size for "${spec}"`
      );
    }
    if (size > STRUCTURED_DIFF_CONTENT_CAP_BYTES) {
      return { kind: 'over-cap', size };
    }
    const blobRun = await invoke(['cat-file', 'blob', spec], {
      ...options,
      binaryStdout: true,
    });
    if (blobRun.exitCode !== 0 || blobRun.failureReason !== undefined) {
      if (blobRun.exitCode === 128 && CAT_FILE_ABSENT_STDERR_PATTERN.test(blobRun.stderr)) {
        // Absent between probe and read — an honest absent side, not an error.
        return { kind: 'absent' };
      }
      throw new SnapshotGitError(
        'git-command-failed',
        `git cat-file blob ${spec} failed: ${describeFailure(blobRun)}`
      );
    }
    if (blobRun.stdoutBuffer === undefined) {
      throw new SnapshotGitError(
        'git-command-failed',
        `runner returned no buffer for "${spec}" — binaryStdout contract violation`
      );
    }
    return { content: blobRun.stdoutBuffer, kind: 'present' };
  }

  return {
    ensureInitialized,
    hookFreeCommands,
    invoke,
    readBlobSized,
    resolveRefOrNull,
    runOrThrow,
    withTempIndex,
  };
}

export type ShadowGitPlumbing = ReturnType<typeof createShadowGitPlumbing>;
