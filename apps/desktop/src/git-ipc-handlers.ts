/**
 * Main-process handlers for the desktop `git` IPC domain.
 *
 * Responsibilities (the security-critical seam):
 * 1. Resolve a renderer-supplied `rootId` to a workspace root that is KNOWN to
 *    the app — never an arbitrary cwd. Roots come from the DB `roots` table (the
 *    same source the assistant's read/search tools use), so `git` can only ever
 *    run inside a folder the user actually opened. `realpath` then canonicalizes
 *    that root to its real path, which becomes the pinned cwd (git runs AT the
 *    root — there is no user-supplied subpath here to widen).
 * 2. Per-PATH containment (the `path` arg of diff/stage/unstage, and the paths
 *    `git status` reports) is enforced inside the service: status is scoped to
 *    the opened root and path args that are absolute or escape via `..` are
 *    rejected before reaching git.
 * 3. Run `git` through {@link createGitService} with an `execFile`-backed runner
 *    — args array, NO shell, so a branch name / commit message / path can never
 *    inject a command. No `exec`/`execSync` anywhere.
 *
 * Every handler returns a structured `GitResult` (or a `{ ok:false }` envelope);
 * git failures are logged and surfaced, never thrown across IPC and never
 * silently swallowed.
 */
import { type ExecFileException, execFile } from 'node:child_process';
import { createLogger } from '@brainstrike/logging';
import type { StructuredFileDiffParams } from '@brainstrike/types';
import {
  createGitService,
  GIT_MAX_BUFFER_BYTES,
  type GitCommandRun,
  type GitCommandRunner,
  type GitDiffParams,
  type GitResult,
} from './assistant-server/git-service';
import {
  loadWorkspaceRootsFromDatabase,
  type WorkspaceRootsQueryable,
} from './assistant-server/workspace-roots';
import { runWindowsGitCommand } from './git-command-windows';
import { resolveRootCwd, type WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('GitIpc');

export type { WorkspaceRootResolver } from './workspace-root-cwd';

const PRESERVED_GIT_ENV_KEYS = new Set([
  'GIT_ALLOW_PROTOCOL',
  'GIT_ASKPASS',
  'GIT_AUTHOR_DATE',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_NAME',
  'GIT_COMMITTER_DATE',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_LFS_SKIP_PUSH',
  'GIT_LFS_SKIP_SMUDGE',
  'GIT_PROTOCOL_FROM_USER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
]);

/**
 * Caller overrides win for ordinary environment entries, but these values are
 * part of the runner's safety contract and are re-applied after every merge.
 */
export const SAFETY_PINNED_GIT_ENVIRONMENT: readonly (readonly [string, string])[] = [
  // An interactive credential prompt would wedge a headless main-process call.
  ['GIT_TERMINAL_PROMPT', '0'],
  // Git path arguments assembled by services must remain literal pathspecs.
  ['GIT_LITERAL_PATHSPECS', '1'],
  // Structured error classification depends on stable, parseable Git wording.
  ['LC_ALL', 'C'],
];

/**
 * Remove inherited `GIT_*` variables case-insensitively, then restore the
 * audited controls that carry explicit identity, authentication, protocol, and
 * Git LFS safety intent. Everything capable of redirecting repositories,
 * objects, indexes, config, grafts, shallow boundaries, replace refs, hooks, or
 * helpers stays removed. Ordinary environment, including SSH agent/socket
 * configuration, also remains intact for explicit network actions.
 */
export function createPinnedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  const preservedGitEnvironment = new Map<string, string>();
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (!normalizedKey.startsWith('GIT_')) {
      continue;
    }
    const value = environment[key];
    if (value !== undefined && PRESERVED_GIT_ENV_KEYS.has(normalizedKey)) {
      preservedGitEnvironment.set(key, value);
    }
    Reflect.deleteProperty(environment, key);
  }
  for (const [key, value] of preservedGitEnvironment) {
    environment[key] = value;
  }
  environment['GIT_OPTIONAL_LOCKS'] = '0';
  environment['GIT_LITERAL_PATHSPECS'] = '1';
  environment['GIT_TERMINAL_PROMPT'] = '0';
  // The structured-diff engine parses git's stderr programmatically (absent
  // vs. real-error classification, `isNotARepository`) — a localized git
  // (e.g. a French or German OS locale) emits translated messages that would
  // silently break every one of those pattern matches. Pin to the C locale so
  // stderr wording is stable regardless of the host's configured locale.
  environment['LC_ALL'] = 'C';
  environment['LANG'] = 'C';
  return environment;
}

/** Merge ordinary per-command overrides, then restore non-overridable safety pins. */
export function createGitCommandEnvironment(
  source: NodeJS.ProcessEnv,
  envOverride?: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const environment = { ...createPinnedGitEnvironment(source), ...envOverride };
  for (const [key, value] of SAFETY_PINNED_GIT_ENVIRONMENT) {
    environment[key] = value;
  }
  return environment;
}

/**
 * Adapt Node's `execFile` to the {@link GitCommandRunner} contract.
 *
 * - `git` is invoked with an ARGUMENT ARRAY (no shell): shell metacharacters in
 *   any arg are inert. There is deliberately no `shell: true`.
 * - `execFile` REJECTS on a non-zero exit; we catch and resolve a structured
 *   {@link GitCommandRun} (never reject) so the service maps it to a result.
 * - The capture buffer is {@link GIT_MAX_BUFFER_BYTES} (strictly larger than the
 *   service's soft `GIT_MAX_OUTPUT_BYTES`), so an oversized-but-valid diff is
 *   captured and gracefully truncated rather than killed and mislabeled.
 * - `error.killed === true` conflates three distinct causes; we DISCRIMINATE
 *   them into {@link GitCommandRun.failureReason}:
 *   - `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` → 'maxBuffer' (partial stdout is a
 *     valid diff prefix; the service returns a truncated SUCCESS), and
 *   - an abort/timeout kill → 'timeout' (accurate message), while
 *   - a missing `git` binary (`ENOENT`) → 'notFound' (clear install hint).
 */
/**
 * Discriminate an `execFile` error's cause into `failureReason`, independent of
 * whether the run captured text or raw bytes. `code` is the numeric exit code on
 * a normal non-zero exit, or a string errno: 'ENOENT' (missing binary) or
 * 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' (output overflow). A kill that is NOT a
 * maxBuffer overflow is a timeout/abort. Shared by both the text and
 * {@link binaryStdout} paths so the mapping stays identical for each.
 */
function classifyExecError(
  error: ExecFileException
): Pick<GitCommandRun, 'exitCode' | 'failureReason' | 'timedOut'> {
  const code = error.code;
  const exitCode = typeof code === 'number' ? code : null;
  let failureReason: GitCommandRun['failureReason'];
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    failureReason = 'maxBuffer';
  } else if (code === 'ENOENT') {
    failureReason = 'notFound';
  } else if (error.killed === true) {
    failureReason = 'timeout';
  }
  return {
    exitCode,
    timedOut: failureReason === 'timeout',
    ...(failureReason ? { failureReason } : {}),
  };
}

export const execFileGitRunner: GitCommandRunner = ({
  args,
  binaryStdout,
  cwd,
  env: envOverride,
  signal,
  timeoutMs,
}) => {
  const env = createGitCommandEnvironment(process.env, envOverride);

  if (process.platform === 'win32') {
    return runWindowsGitCommand({ args, binaryStdout, cwd, env, signal, timeoutMs });
  }

  if (binaryStdout) {
    return new Promise<GitCommandRun>((resolve) => {
      execFile(
        'git',
        [...args],
        {
          cwd,
          encoding: 'buffer',
          env,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          signal,
          timeout: timeoutMs,
        },
        (error, stdout, stderr) => {
          // `encoding: 'buffer'` applies to BOTH streams; stderr stays text (it
          // only ever carries diagnostic messages), stdout carries the exact
          // captured bytes — never a lossy utf8 decode.
          const stderrText = stderr.toString('utf8');
          if (error) {
            // Preserve the captured (possibly partial, e.g. on maxBuffer
            // overflow) bytes rather than silently dropping them.
            resolve({
              ...classifyExecError(error),
              stderr: stderrText,
              stdout: '',
              stdoutBuffer: stdout,
            });
            return;
          }
          resolve({
            exitCode: 0,
            stderr: stderrText,
            stdout: '',
            stdoutBuffer: stdout,
            timedOut: false,
          });
        }
      );
    });
  }

  return new Promise<GitCommandRun>((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, env, maxBuffer: GIT_MAX_BUFFER_BYTES, signal, timeout: timeoutMs },
      (error, stdout, stderr) => {
        // Default `execFile` encoding is utf8, so the streams are strings. On a
        // maxBuffer overflow these still hold the captured (truncated) prefix.
        if (error) {
          resolve({ ...classifyExecError(error), stderr, stdout });
          return;
        }
        resolve({ exitCode: 0, stderr, stdout, timedOut: false });
      }
    );
  });
};

/**
 * Build a {@link WorkspaceRootResolver} backed by the DB `roots` table. Mirrors
 * the assistant-server's `enrichRuntimeDataWithWorkspaceRoots` seam so the git
 * domain validates against the SAME source of truth as the read/search tools.
 */
export function createDatabaseRootResolver(
  getDatabase: () => Promise<WorkspaceRootsQueryable>
): WorkspaceRootResolver {
  return {
    listRoots: async () => {
      const db = await getDatabase();
      return await loadWorkspaceRootsFromDatabase(db);
    },
  };
}

export interface GitIpcHandlersOptions {
  readonly resolver: WorkspaceRootResolver;
  /** Injectable for tests; defaults to the real `execFile`-backed runner. */
  readonly run?: GitCommandRunner;
}

/**
 * Create the dependency-injected git IPC handlers. Each handler resolves +
 * validates the cwd, then delegates to the git-service, returning the structured
 * result verbatim (a resolution failure is itself a `{ ok:false }` result).
 */
export function createGitIpcHandlers({ resolver, run = execFileGitRunner }: GitIpcHandlersOptions) {
  async function withService<T>(
    rootId: unknown,
    op: (service: ReturnType<typeof createGitService>) => Promise<GitResult<T>>
  ): Promise<GitResult<T>> {
    const cwd = await resolveRootCwd(resolver, rootId, 'git', logger);
    if (!cwd.ok) {
      return cwd;
    }
    const service = createGitService({ cwd: cwd.value, run });
    try {
      return await op(service);
    } catch (error) {
      logger.error('Unexpected git handler failure', { error });
      return { error: error instanceof Error ? error.message : String(error), ok: false };
    }
  }

  return {
    aheadBehind: (rootId: unknown) => withService(rootId, (service) => service.aheadBehind()),
    commit: (rootId: unknown, params: { description?: string; summary: string }) =>
      withService(rootId, (service) =>
        service.commit({ description: params?.description, summary: params?.summary })
      ),
    commitFiles: (rootId: unknown, params: { commit: string }) =>
      withService(rootId, (service) => service.commitFiles({ commit: params?.commit })),
    createBranch: (rootId: unknown, params: { branch: string; startPoint?: string }) =>
      withService(rootId, (service) =>
        service.createBranch({
          branch: params?.branch,
          // Forward on `!== undefined`, not truthiness: an explicit '' must
          // reach the service and hit ITS stated refusal, not get silently
          // dropped here and treated as "no start point supplied".
          ...(params?.startPoint === undefined ? {} : { startPoint: params.startPoint }),
        })
      ),
    diff: (rootId: unknown, params: unknown) =>
      withService(rootId, (service) => service.diff(params as GitDiffParams)),
    fetch: (rootId: unknown, params: { remote: string }) =>
      withService(rootId, (service) => service.fetch({ remote: params?.remote })),
    history: (rootId: unknown, params: { limit: number; offset: number; ref?: string }) =>
      withService(rootId, (service) =>
        service.history({ limit: params?.limit, offset: params?.offset, ref: params?.ref })
      ),
    pull: (rootId: unknown) => withService(rootId, (service) => service.pull()),
    push: (rootId: unknown, params: { remote?: string } = {}) =>
      withService(rootId, (service) => service.push({ remote: params?.remote })),
    repository: (rootId: unknown) => withService(rootId, (service) => service.repository()),
    stage: (rootId: unknown, params: { path?: string } = {}) =>
      withService(rootId, (service) => service.stage({ path: params.path })),
    status: (rootId: unknown) => withService(rootId, (service) => service.status()),
    structuredFileDiff: (rootId: unknown, params: unknown) =>
      withService(rootId, (service) =>
        service.structuredFileDiff(params as StructuredFileDiffParams)
      ),
    switchBranch: (rootId: unknown, params: { branch: string }) =>
      withService(rootId, (service) => service.switchBranch({ branch: params?.branch })),
    unstage: (rootId: unknown, params: { path?: string } = {}) =>
      withService(rootId, (service) => service.unstage({ path: params.path })),
  };
}

export type GitIpcHandlers = ReturnType<typeof createGitIpcHandlers>;
