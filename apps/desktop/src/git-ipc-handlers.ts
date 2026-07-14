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
import { createLogger } from '@brainstrike/utils/logger';
import {
  createGitService,
  GIT_MAX_BUFFER_BYTES,
  type GitCommandRun,
  type GitCommandRunner,
  type GitResult,
} from './assistant-server/git-service';
import {
  loadWorkspaceRootsFromDatabase,
  type WorkspaceRootsQueryable,
} from './assistant-server/workspace-roots';
import { resolveRootCwd, type WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('GitIpc');

export type { WorkspaceRootResolver } from './workspace-root-cwd';

/**
 * Remove every inherited `GIT_*` variable before pinning the small, explicit set
 * this domain owns. Git's environment surface can redirect repositories,
 * objects, indexes, config, grafts, shallow boundaries, replace refs, hooks,
 * pagers, and network helpers; an allowlist would silently become incomplete as
 * Git adds more variables. Ordinary environment, including SSH agent/socket
 * configuration, remains intact for explicit network actions.
 */
export function createPinnedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) {
      Reflect.deleteProperty(environment, key);
    }
  }
  environment['GIT_OPTIONAL_LOCKS'] = '0';
  environment['GIT_TERMINAL_PROMPT'] = '0';
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
 * Map an `execFile` error into a {@link GitCommandRun}, discriminating the cause
 * into `failureReason`. `code` is the numeric exit code on a normal non-zero
 * exit, or a string errno: 'ENOENT' (missing binary) or
 * 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' (output overflow). A kill that is NOT a
 * maxBuffer overflow is a timeout/abort.
 */
function classifyExecError(
  error: ExecFileException,
  stdout: string,
  stderr: string
): GitCommandRun {
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
    stderr,
    stdout,
    timedOut: failureReason === 'timeout',
    ...(failureReason ? { failureReason } : {}),
  };
}

export const execFileGitRunner: GitCommandRunner = ({ args, cwd, signal, timeoutMs }) => {
  return new Promise<GitCommandRun>((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        // Discourage interactive credential prompts that would hang a push/pull
        // in a headless main process; surface an auth error instead of blocking.
        env: createPinnedGitEnvironment(process.env),
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        signal,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        // Default `execFile` encoding is utf8, so the streams are strings. On a
        // maxBuffer overflow these still hold the captured (truncated) prefix.
        if (error) {
          resolve(classifyExecError(error, stdout, stderr));
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
    commitDiff: (
      rootId: unknown,
      params: { commit: string; originalPath?: string; path: string }
    ) =>
      withService(rootId, (service) =>
        service.commitDiff({
          commit: params?.commit,
          originalPath: params?.originalPath,
          path: params?.path,
        })
      ),
    commitFiles: (rootId: unknown, params: { commit: string }) =>
      withService(rootId, (service) => service.commitFiles({ commit: params?.commit })),
    diff: (
      rootId: unknown,
      params: { path?: string; staged?: boolean; untracked?: boolean } = {}
    ) =>
      withService(rootId, (service) =>
        service.diff({ path: params.path, staged: params.staged, untracked: params.untracked })
      ),
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
    switchBranch: (rootId: unknown, params: { branch: string }) =>
      withService(rootId, (service) => service.switchBranch({ branch: params?.branch })),
    unstage: (rootId: unknown, params: { path?: string } = {}) =>
      withService(rootId, (service) => service.unstage({ path: params.path })),
  };
}

export type GitIpcHandlers = ReturnType<typeof createGitIpcHandlers>;
