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
 * 3. Run `git` through {@link createGitService} with a `spawn`-backed runner
 *    — args array, NO shell, so a branch name / commit message / path can never
 *    inject a command. No `exec`/`execSync` anywhere.
 *
 * Every handler returns a structured `GitResult` (or a `{ ok:false }` envelope);
 * git failures are logged and surfaced, never thrown across IPC and never
 * silently swallowed.
 */
import type { Readable } from 'node:stream';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { endTreeOnDeadline, spawnNativeChild } from '@brainstrike/state-store/native-children';
import type { StructuredFileDiffParams } from '@brainstrike/types';
import {
  createGitService,
  GIT_MAX_BUFFER_BYTES,
  type GitCommandRun,
  type GitCommandRunner,
  type GitDiffParams,
  type GitResult,
} from './assistant-server/git-service';
import { loadWorkspaceRootsFromCatalog } from './assistant-server/workspace-roots';
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
const SAFETY_PINNED_GIT_ENVIRONMENT: readonly (readonly [string, string])[] = [
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
function createPinnedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
function createGitCommandEnvironment(
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
 * Capture one stream of a git child, keeping at most {@link GIT_MAX_BUFFER_BYTES}.
 * Past the ceiling it keeps the prefix and closes this end of the pipe: git's
 * next write then fails and git ends itself, exactly as in `git diff | head`.
 */
function captureBounded(stream: Readable): { bytes(): Buffer; readonly truncated: boolean } {
  const chunks: Buffer[] = [];
  let length = 0;
  let truncated = false;
  stream.on('data', (chunk: Buffer) => {
    const room = GIT_MAX_BUFFER_BYTES - length;
    if (chunk.length <= room) {
      chunks.push(chunk);
      length += chunk.length;
      return;
    }
    chunks.push(chunk.subarray(0, room));
    length += room;
    truncated = true;
    stream.destroy();
  });
  return {
    bytes: () => Buffer.concat(chunks, length),
    get truncated() {
      return truncated;
    },
  };
}

function classifyGitRun(
  truncated: boolean,
  spawnError: NodeJS.ErrnoException | undefined,
  killed: boolean
): GitCommandRun['failureReason'] {
  if (truncated) {
    return 'maxBuffer';
  }
  if (spawnError?.code === 'ENOENT') {
    return 'notFound';
  }
  return killed ? 'timeout' : undefined;
}

/**
 * Run `git` for the {@link GitCommandRunner} contract.
 *
 * - `git` gets an ARGUMENT ARRAY and no shell, so shell metacharacters in any
 *   arg are inert.
 * - The run resolves (never rejects) at the child's `close`, after git has
 *   exited, with the captured streams and a discriminated `failureReason`:
 *   - 'maxBuffer': output passed {@link GIT_MAX_BUFFER_BYTES}. The kept prefix
 *     is a valid diff prefix, so the service returns a truncated SUCCESS.
 *     Overflow never kills git: Git for Windows' `cmd\git.exe` is a launcher,
 *     and a kill stops only the launcher while the real git keeps running in
 *     the repository. Closing the pipe ends both.
 *   - 'timeout': the timeout or the caller's AbortSignal ended the run. Either
 *     ends git's whole tree, so the real git under the launcher ends too.
 *   - 'notFound': `git` could not be spawned (ENOENT).
 * - `exitCode` is null whenever the run did not complete on its own terms.
 */
function runGitProcess({
  args,
  binaryStdout,
  cwd,
  env,
  signal,
  timeoutMs,
}: {
  readonly args: readonly string[];
  readonly binaryStdout?: boolean | undefined;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}): Promise<GitCommandRun> {
  return new Promise<GitCommandRun>((resolve) => {
    const child = spawnNativeChild('git', args, { cwd, env });
    const deadline = endTreeOnDeadline(child, {
      onError: (cause) => logger.warn('Could not end the git process tree', { cause }),
      signal,
      timeoutMs,
    });
    const stdout = captureBounded(child.stdout);
    const stderr = captureBounded(child.stderr);
    let spawnError: NodeJS.ErrnoException | undefined;
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError ??= error;
    });
    child.on('close', (code) => {
      deadline.clear();
      const failureReason = classifyGitRun(
        stdout.truncated || stderr.truncated,
        spawnError,
        deadline.ended
      );
      const captured = stdout.bytes();
      const run = {
        exitCode: failureReason || spawnError ? null : code,
        stderr: stderr.bytes().toString('utf8'),
        timedOut: failureReason === 'timeout',
        ...(failureReason ? { failureReason } : {}),
      };
      resolve(
        binaryStdout
          ? { ...run, stdout: '', stdoutBuffer: captured }
          : { ...run, stdout: captured.toString('utf8') }
      );
    });
  });
}

/** The production runner: the pinned git environment plus the caller's overrides. */
export const execFileGitRunner: GitCommandRunner = ({ env, ...params }) =>
  runGitProcess({ ...params, env: createGitCommandEnvironment(process.env, env) });

/** Reads the current host's durable root identity while Main retains path authorization. */
export function createWorkspaceRootResolver(catalog: WorkspaceRootPort): WorkspaceRootResolver {
  return { listRoots: async () => await loadWorkspaceRootsFromCatalog(catalog) };
}

export interface GitIpcHandlersOptions {
  readonly resolver: WorkspaceRootResolver;
  /** Injectable for tests; defaults to the real {@link execFileGitRunner}. */
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
