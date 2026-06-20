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
import fsPromises from 'node:fs/promises';
import path from 'node:path';
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

const logger = createLogger('GitIpc');

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
    stdout,
    stderr,
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
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        signal,
        // Discourage interactive credential prompts that would hang a push/pull
        // in a headless main process; surface an auth error instead of blocking.
        env: {
          ...process.env,
          // biome-ignore lint/style/useNamingConvention: standard git env var names (must be uppercase).
          GIT_TERMINAL_PROMPT: '0',
          // biome-ignore lint/style/useNamingConvention: standard git env var names (must be uppercase).
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
      (error, stdout, stderr) => {
        // Default `execFile` encoding is utf8, so the streams are strings. On a
        // maxBuffer overflow these still hold the captured (truncated) prefix.
        if (error) {
          resolve(classifyExecError(error, stdout, stderr));
          return;
        }
        resolve({ exitCode: 0, stdout, stderr, timedOut: false });
      }
    );
  });
};

/** Resolves the active path-backed workspace roots for cwd validation. */
export interface WorkspaceRootResolver {
  /** Returns the known roots as `{ rootId, path, displayName }`. */
  listRoots(): Promise<readonly { displayName: string; path: string; rootId: string }[]>;
}

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

/**
 * Resolve a renderer-supplied `rootId` to a canonical, containment-checked
 * absolute path. Rejects any id that does not match a known root (no arbitrary
 * cwd) and any root whose path no longer resolves on disk.
 */
async function resolveRootCwd(
  resolver: WorkspaceRootResolver,
  rootId: unknown
): Promise<GitResult<string>> {
  if (typeof rootId !== 'string' || rootId.trim().length === 0) {
    return { ok: false, error: 'git requires a non-empty rootId string' };
  }
  const trimmed = rootId.trim();
  let roots: readonly { displayName: string; path: string; rootId: string }[];
  try {
    roots = await resolver.listRoots();
  } catch (error) {
    logger.error('Failed to load workspace roots for git domain', { error });
    return { ok: false, error: 'Workspace roots are unavailable.' };
  }
  const match = roots.find((root) => root.rootId === trimmed);
  if (!match) {
    return { ok: false, error: `No open folder matches root id "${trimmed}".` };
  }
  if (!path.isAbsolute(match.path)) {
    // Web / FSA roots have no real filesystem path → git is not addressable.
    return { ok: false, error: 'The selected folder has no local filesystem path.' };
  }
  try {
    // Canonicalize the DB-known root to its real path (resolving any symlinks),
    // and use THAT as the pinned cwd. We run git AT the root itself — there is no
    // user-supplied subpath to widen here, so the containment guarantee is simply
    // "cwd === realpath(a root the user opened)". Per-path containment (for the
    // `path` args of diff/stage/unstage) is enforced separately in the service.
    const canonicalRoot = await fsPromises.realpath(match.path);
    return { ok: true, value: canonicalRoot };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: 'The selected folder no longer exists on disk.' };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
    const cwd = await resolveRootCwd(resolver, rootId);
    if (!cwd.ok) {
      return cwd;
    }
    const service = createGitService({ cwd: cwd.value, run });
    try {
      return await op(service);
    } catch (error) {
      logger.error('Unexpected git handler failure', { error });
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    status: (rootId: unknown) => withService(rootId, (service) => service.status()),
    diff: (rootId: unknown, params: { path?: string; staged?: boolean } = {}) =>
      withService(rootId, (service) => service.diff({ path: params.path, staged: params.staged })),
    stage: (rootId: unknown, params: { path?: string } = {}) =>
      withService(rootId, (service) => service.stage({ path: params.path })),
    unstage: (rootId: unknown, params: { path?: string } = {}) =>
      withService(rootId, (service) => service.unstage({ path: params.path })),
    commit: (rootId: unknown, params: { message: string }) =>
      withService(rootId, (service) => service.commit({ message: params?.message })),
    aheadBehind: (rootId: unknown) => withService(rootId, (service) => service.aheadBehind()),
    push: (rootId: unknown) => withService(rootId, (service) => service.push()),
    pull: (rootId: unknown) => withService(rootId, (service) => service.pull()),
  };
}

export type GitIpcHandlers = ReturnType<typeof createGitIpcHandlers>;
