/**
 * The agent host's `git/*` methods (ADR-0029 stage 2).
 *
 * Responsibilities (the security-critical seam):
 * 1. Resolve a client-supplied `rootId` to a workspace root that is KNOWN to
 *    the app — never an arbitrary cwd. Roots come from the DB `roots` table (the
 *    same source the assistant's read/search tools use), so `git` can only ever
 *    run inside a folder the user actually opened. `realpath` then canonicalizes
 *    that root to its real path, which becomes the pinned cwd (git runs AT the
 *    root — there is no user-supplied subpath here to widen).
 * 2. The paths `git status` reports are scoped to the opened root inside the
 *    service.
 * 3. Run `git` through {@link createGitService} with a `spawn`-backed runner
 *    — args array, NO shell, so a branch name / commit message / path can never
 *    inject a command. No `exec`/`execSync` anywhere.
 *
 * Every handler returns a structured `BoundaryResult` (or a `{ ok:false }` envelope);
 * git failures are logged and surfaced, never thrown across the wire and never
 * silently swallowed.
 */

import type { Readable } from 'node:stream';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import { endTreeOnDeadline, spawnNativeChild } from '@brainstrike/state-store/native-children';
import { resolveRootCwd, type WorkspaceRootResolver } from '../workspace-root-cwd.ts';
import { gitThrew } from './git-failure.ts';
import {
  createGitService,
  GIT_MAX_BUFFER_BYTES,
  type GitCommandRun,
  type GitCommandRunner,
} from './git-service.ts';

const logger = createLogger('GitMethods');

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
  input,
  signal,
  timeoutMs,
}: {
  readonly args: readonly string[];
  readonly binaryStdout?: boolean | undefined;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input?: string | undefined;
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
    if (input !== undefined) {
      // A git that exits before reading all of it closes the pipe (EPIPE); its
      // exit code and stderr report why.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
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

export interface GitMethodsOptions {
  readonly resolver: WorkspaceRootResolver;
  /** Injectable for tests; defaults to the real {@link execFileGitRunner}. */
  readonly run?: GitCommandRunner;
}

/**
 * Create the dependency-injected git methods. Each handler resolves +
 * validates the cwd, then delegates to the git-service, returning the structured
 * result verbatim (a resolution failure is itself a `{ ok:false }` result).
 */
export function createGitMethods({ resolver, run = execFileGitRunner }: GitMethodsOptions) {
  async function withService<T>(
    rootId: unknown,
    op: (service: ReturnType<typeof createGitService>) => Promise<BoundaryResult<T>>
  ): Promise<BoundaryResult<T>> {
    const cwd = await resolveRootCwd(resolver, rootId, 'git', logger);
    if (!cwd.ok) {
      return cwd;
    }
    const service = createGitService({ cwd: cwd.value, run });
    try {
      return await op(service);
    } catch (error) {
      logger.error('Unexpected git handler failure', { error });
      return gitThrew(error);
    }
  }

  return {
    commit: (rootId: unknown, params: { description?: string; summary: string }) =>
      withService(rootId, (service) =>
        service.commit({ description: params?.description, summary: params?.summary })
      ),
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
    fetch: (rootId: unknown, params: { remote: string }) =>
      withService(rootId, (service) => service.fetch({ remote: params?.remote })),
    push: (rootId: unknown, params: { remote?: string } = {}) =>
      withService(rootId, (service) => service.push({ remote: params?.remote })),
    repository: (rootId: unknown) => withService(rootId, (service) => service.repository()),
    status: (rootId: unknown) => withService(rootId, (service) => service.status()),
    switchBranch: (rootId: unknown, params: { branch: string }) =>
      withService(rootId, (service) => service.switchBranch({ branch: params?.branch })),
  };
}

export type GitMethods = ReturnType<typeof createGitMethods>;
