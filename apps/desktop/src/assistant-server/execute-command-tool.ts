import type { ChildProcess } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  type ExecuteCommandInput,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  type RuntimeData,
} from '@brainstrike/agent';
import {
  NATIVE_TOOL_ID,
  requireNativeToolExecutionBudget,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import type { ShellOutputStreamer } from '@brainstrike/host-capabilities/native-tools';
import {
  acquireWorkspaceMutationLease,
  isWithinRoot,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { spawnNativeChild } from '@brainstrike/state-store/native-children';
import stripAnsi from 'strip-ansi';
import treeKill from 'tree-kill';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';
import { createCredentialIsolatedChildEnvironment } from '../desktop-env';
import { KILL_GRACE_MS } from './kill-grace';
import { createWindowsCommandProcess, type WindowsCommandJob } from './windows-command-process';
import {
  describeOpenRootTopology,
  type OpenRootTopology,
  resolveWorkspaceRoot,
} from './workspace-roots';

export const EXECUTE_COMMAND_TOOL_ID = NATIVE_TOOL_ID.executeCommand;

const logger = createLogger('ExecuteCommandTool');
const REDACTED_COMMAND_LOG_VALUE = { redacted: true } as const;
const REDACTED_CWD_LOG_VALUE = { redacted: true } as const;

/**
 * `defaultMs`: per-command timeout when the model does not specify one.
 * `maxMs`: hard ceiling on the per-call timeout so a bad value cannot wedge the host.
 */
const { defaultMs: DEFAULT_TIMEOUT_MS, maxMs: MAX_TIMEOUT_MS } =
  requireNativeToolExecutionBudget(EXECUTE_COMMAND_TOOL_ID);
/** Maximum command-input characters repeated in the model-facing result. */
const MAX_ECHOED_COMMAND_CHARS = 200;
/**
 * Hard ceiling on RAW captured output bytes. Independent of (and larger than)
 * the model-facing token budget: this stops a runaway command from filling
 * memory, while {@link NATIVE_TOOL_RESULT_CHAR_BUDGET} bounds what the model
 * actually sees. Once hit we keep draining the pipes (so the child never blocks
 * on a full buffer) but stop appending.
 */
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
/**
 * Hard ceiling on RAW bytes STREAMED incrementally to the caller (and onward to
 * the model/UI) across BOTH streams combined. Independent of and smaller than
 * {@link MAX_CAPTURED_OUTPUT_BYTES}: a runaway process must not flood the live
 * data stream even though the final captured result is separately budget-fitted.
 * Once hit we emit ONE truncation notice, stop streaming, and keep draining the
 * pipes for the (still-bounded) final result.
 */
const MAX_STREAMED_OUTPUT_BYTES = 256_000;
/** Visible notice appended to the live stream once the streaming cap is hit. */
const STREAM_TRUNCATION_NOTICE =
  '\n[output truncated — live streaming stopped; the final result keeps the start and end of each stream]\n';

/**
 * Resolve the shell + argument convention for the current platform.
 *
 * - POSIX (macOS/Linux): the user's `$SHELL` (or `/bin/sh`) with `-c command`.
 * - Windows: `%ComSpec%` (or `cmd.exe`) with `/d /s /c command` — the same
 *   convention Node's own `child_process` uses for `shell: true`. `/d` skips
 *   AutoRun, `/s /c` runs the rest of the line as-is. `$SHELL` is normally unset
 *   on Windows, so the POSIX fallback to `/bin/sh` would ENOENT — hence the
 *   per-platform split (the original cause of the Windows spawn bug).
 *
 * Exported for unit tests that assert selection per `process.platform`.
 */
export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform
): { shell: string; args: string[] } {
  if (platform === 'win32') {
    const shell = process.env['ComSpec'] || 'cmd.exe';
    return { args: ['/d', '/s', '/c', command], shell };
  }
  const shell = process.env['SHELL'] || '/bin/sh';
  return { args: ['-c', command], shell };
}

export interface ExecuteCommandToolResult {
  ambiguousRootNames?: string[];
  command: string;
  /** Absolute, containment-checked directory the command started in. */
  cwd: string;
  durationMs: number;
  /**
   * Process exit code, or null when the process was terminated by a signal
   * (timeout/abort/kill) before exiting. Never silently coerced to 0.
   */
  exitCode: number | null;
  /** Actionable next step when output was truncated to fit the model budget. */
  hint?: string;
  openRoots?: number;
  /** Durable id of the workspace root the command was resolved against. */
  rootId: string;
  /** Display name of the workspace root the command was resolved against. */
  rootName: string;
  /** Terminating signal name when the process was killed (else null). */
  signal: string | null;
  /** Budget-fitted head and tail of captured stderr (early + recent context). */
  stderr: string;
  /** Budget-fitted head and tail of captured stdout (early + recent context). */
  stdout: string;
  /** True when the command was killed because it exceeded its timeout. */
  timedOut: boolean;
  /** True when stdout/stderr were trimmed to fit the model output budget. */
  truncated: boolean;
}

/**
 * The one process-local registry of finite commands. A Windows entry owns its
 * native Job and workspace lease before the gated wrapper starts, and remains
 * here after a failed native retirement. POSIX keeps its process-group owner.
 */
const liveChildProcesses = new Set<{ retire: () => Promise<void> }>();

/**
 * Kill an entire detached process tree.
 *
 * The child is spawned `detached: true`, so it is the leader of its own process
 * group and `process.kill(-pid, signal)` signals the WHOLE group (the shell AND
 * every grandchild it forked) in one call — the orphan-prevention guarantee.
 * `tree-kill` is the cross-platform backstop (it walks the child tree itself and
 * is the only mechanism on Windows, which has no negative-pid groups). A real
 * kill failure is logged, never swallowed (no-silent-fallbacks) — tree-kill is
 * the authority on whether the tree actually died, because a dead group leader
 * never proves a dead tree.
 *
 * KNOWN, ACCEPTED LIMITATION: a process that deliberately double-forks /
 * daemonizes (setsid → reparents to PID 1 in its own new process group) escapes
 * BOTH the negative-pgid signal AND tree-kill's ps-tree ancestry walk — it is no
 * longer in our group nor a descendant of `pid`. This is a fundamental POSIX
 * limitation (the reference mastra-code-ui shell.ts has it too); you cannot
 * reliably reap a deliberate daemonize by ancestry. Normal agent commands
 * (tests, builds, git, package managers) do not daemonize, so this is acceptable.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid → signal the whole process group (POSIX). Requires the child
    // to have been spawned detached so it leads its own group.
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Neither code proves a FAILURE on its own, so neither warns here:
    //   ESRCH — the group no longer exists (normal once the child has exited).
    //   EPERM — nothing in the group could be signalled. Usually that is the
    //     post-reap window, where the survivors are killed-but-unreaped zombies
    //     Darwin's killpg1() drops from its signalable count (Linux keeps them
    //     in the group and simply succeeds, so this arm is Darwin-observable
    //     only). But it ALSO covers a LIVE member we may not signal — a `sudo`
    //     or setuid process an arbitrary user command started — which is a real
    //     orphan. Unlike the conformance driver's `killPosixProcessGroup`
    //     (BST-1674), this tool runs arbitrary commands, so "every member is our
    //     own descendant running as us" does NOT hold here. EPERM is therefore
    //     inconclusive, never proof of success.
    // tree-kill below resolves most of that ambiguity: it signals the positive
    // pid and every descendant individually, so a survivor it can SEE fails
    // there and is logged with its own error. Its reach is the PPID tree
    // (`pgrep -P`), not the process group, so a group member whose intermediate
    // parent already exited — reparented to PID 1 — is invisible to it. That
    // residual case is why EPERM still emits a debug line: no warn (this window
    // is usually benign, and warn-noise is what this guard exists to remove),
    // but never a completely silent teardown either.
    if (code === 'EPERM') {
      logger.debug('Process-group kill found nothing signalable', { code, pid, signal });
    } else if (code !== 'ESRCH') {
      logger.warn('Process-group kill failed; falling back to tree-kill', {
        code,
        pid,
        signal,
      });
    }
  }
  // Always also run tree-kill: it covers Windows (no process groups) and any
  // grandchild that escaped the group (rare, but the recipe is belt-and-braces).
  treeKill(pid, signal, (error) => {
    // NOT gated on the group kill: a dead group leader does not prove a dead
    // tree, and the escaped grandchild is the exact case tree-kill exists for.
    // The already-dead race is filtered by message alone (no-silent-fallbacks).
    if (error && !/no such process/i.test(error.message)) {
      logger.warn('tree-kill failed', { error: error.message, pid, signal });
    }
  });
}

/**
 * Reap every still-live child spawned by this tool. Wired into the desktop
 * shutdown / factory-reset lifecycle so no orphaned subprocess survives the app.
 * Returns the number of owners joined (for logging/observability). Failed
 * retirement leaves that owner retained and rejects disposal.
 */
export async function disposeLiveChildProcesses(): Promise<number> {
  const entries = [...liveChildProcesses];
  const outcomes = await Promise.allSettled(
    entries.map((entry) => Promise.resolve().then(() => entry.retire()))
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Live command process retirement failed');
  }
  if (entries.length > 0) {
    logger.info('Reaped live shell child processes on dispose', { count: entries.length });
  }
  return entries.length;
}

/**
 * Resolve and containment-check the directory the command will start in.
 *
 * The command body is unrestricted (it can `cd` anywhere — there is NO sandbox),
 * but the START directory is pinned inside a workspace root, mirroring the fs
 * tools. `cwd` is an absolute path (or a workspace-relative path) that, after
 * symlink resolution, MUST live within the resolved root, or we throw.
 */
async function resolveCommandCwd(
  runtimeData: RuntimeData | undefined,
  rootQualifier: string | undefined,
  requestedCwd: string | undefined
): Promise<{ cwd: string; rootId: string; rootName: string; rootPath: string }> {
  const root = resolveWorkspaceRoot(runtimeData, rootQualifier);
  const canonicalRootPath = await fsPromises.realpath(root.path);
  if (requestedCwd === undefined || requestedCwd.trim().length === 0) {
    return {
      cwd: canonicalRootPath,
      rootId: root.rootId,
      rootName: root.displayName,
      rootPath: canonicalRootPath,
    };
  }
  // A relative cwd is resolved against the root; an absolute cwd is taken as-is.
  // Either way the canonical (symlink-resolved) result must be inside the root.
  const absoluteCwd = path.isAbsolute(requestedCwd)
    ? requestedCwd
    : path.resolve(canonicalRootPath, requestedCwd);
  let canonicalCwd: string;
  try {
    canonicalCwd = await fsPromises.realpath(absoluteCwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ToolInputError(`cwd "${requestedCwd}" does not exist.`);
    }
    throw error;
  }
  if (!isWithinRoot(canonicalRootPath, canonicalCwd)) {
    throw new ToolInputError(
      `cwd "${requestedCwd}" resolves outside the workspace root "${root.displayName}". A command's start directory must be inside an open folder.`
    );
  }
  return {
    cwd: canonicalCwd,
    rootId: root.rootId,
    rootName: root.displayName,
    rootPath: canonicalRootPath,
  };
}

export interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

/**
 * Build a stateful emitter that forwards ANSI-stripped output slices to the live
 * {@link ShellOutputStreamer}, honoring the COMBINED streaming cap
 * ({@link MAX_STREAMED_OUTPUT_BYTES}). Once the cap is hit it emits exactly one
 * truncation notice and stops (capture continues independently, so the final
 * result is unaffected). A throwing sink disables streaming but never breaks
 * command execution. Returns a no-op when there is no streamer.
 */
function createBoundedShellStreamer(
  streamer: ShellOutputStreamer | undefined
): (kind: 'stdout' | 'stderr', text: string) => void {
  if (!streamer) {
    return () => {
      // No live consumer: streaming is skipped, the command still runs.
    };
  }
  let streamedBytes = 0;
  let truncated = false;
  return (kind, text) => {
    if (truncated || text.length === 0) {
      return;
    }
    const cleaned = stripAnsi(text);
    if (cleaned.length === 0) {
      return;
    }
    const remaining = MAX_STREAMED_OUTPUT_BYTES - streamedBytes;
    const emitted =
      cleaned.length <= remaining ? cleaned : cleaned.slice(0, Math.max(0, remaining));
    try {
      if (emitted.length > 0) {
        streamer({ chunk: emitted, stream: kind });
      }
      if (cleaned.length > remaining) {
        truncated = true;
        streamer({ chunk: STREAM_TRUNCATION_NOTICE, stream: kind, truncated: true });
      }
    } catch (error) {
      truncated = true;
      logger.warn('Shell output streamer threw; disabling live streaming', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    streamedBytes += emitted.length;
  };
}

/**
 * Spawn the user's platform shell (see {@link resolveShellInvocation}), detached
 * so the child leads its own process group. Captures stdout/stderr up to
 * {@link MAX_CAPTURED_OUTPUT_BYTES}. Windows joins its parent-owned Job and
 * captured pipes before releasing the retained owner. POSIX keeps its existing
 * SIGTERM/SIGKILL process-group cleanup and joins the child close event.
 */
interface ProcessArguments {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  executable: string;
  /** Ownership transfers at the call; only actual settlement can release it. */
  releaseWorkspaceLease?: () => void;
  signal: AbortSignal | undefined;
  streamer: ShellOutputStreamer | undefined;
  timeoutMs: number;
  windowsVerbatimArguments?: boolean;
}

function commandEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const requestedEnvironment = {
    ...process.env,
    ...env,
    // biome-ignore lint/style/useNamingConvention: CI is a standard env var name.
    CI: 'true',
  };
  const childEnvironment = createCredentialIsolatedChildEnvironment(requestedEnvironment);
  const strippedCredentialCount =
    Object.keys(requestedEnvironment).length - Object.keys(childEnvironment).length;
  if (strippedCredentialCount > 0) {
    logger.debug('command environment removed provider credentials', { strippedCredentialCount });
  }
  return childEnvironment;
}

function runWindowsCommand(args: ProcessArguments): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    if (args.signal?.aborted) {
      args.releaseWorkspaceLease?.();
      reject(new Error('Command aborted before execution.'));
      return;
    }
    let retained = false;
    try {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      const emitStream = createBoundedShellStreamer(args.streamer);
      const userEnvironment = Object.fromEntries(
        Object.entries(commandEnvironment(args.env)).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !/^NODE_CHANNEL_(?:FD|SERIALIZATION_MODE)$/iu.test(entry[0])
        )
      );
      const wrapperEnvironment = Object.fromEntries(
        Object.entries(commandEnvironment(undefined)).filter(
          ([name]) =>
            !/^(?:NODE_OPTIONS|NODE_PATH|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|ELECTRON_RUN_AS_NODE)$/iu.test(
              name
            )
        )
      );
      wrapperEnvironment['ELECTRON_RUN_AS_NODE'] = '1';
      const wrapperPath = resolveBundledSiblingPath('Windows command', 'windows-command-entry.js');
      const owner = createWindowsCommandProcess({
        command: {
          // Match Node's cmd.exe shell convention only at this finite-command
          // verbatim boundary. The shared PTY invocation and direct skill argv stay unchanged.
          argv: args.windowsVerbatimArguments
            ? args.argv.map((argument, index) =>
                index === args.argv.length - 1 ? `"${argument}"` : argument
              )
            : args.argv,
          cwd: args.cwd,
          env: userEnvironment,
          executable: args.executable,
          windowsVerbatimArguments: args.windowsVerbatimArguments ?? false,
        },
        createJob: () => {
          const native = createRequire(wrapperPath)('@brainstrike/windows-job-native') as {
            createCommandJob(): WindowsCommandJob;
          };
          return native.createCommandJob();
        },
        onOutput: (kind, chunk) => {
          const text = chunk.toString('utf8');
          emitStream(kind, text);
          if (kind === 'stdout' && stdoutBytes < MAX_CAPTURED_OUTPUT_BYTES) {
            stdout += text;
            stdoutBytes += chunk.byteLength;
          } else if (kind === 'stderr' && stderrBytes < MAX_CAPTURED_OUTPUT_BYTES) {
            stderr += text;
            stderrBytes += chunk.byteLength;
          }
        },
        onSettled: () => {
          liveChildProcesses.delete(owner);
          args.releaseWorkspaceLease?.();
        },
        spawnWrapper: () =>
          spawnNativeChild(process.execPath, [wrapperPath], {
            cwd: args.cwd,
            detached: false,
            env: wrapperEnvironment,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            windowsHide: true,
          }),
      });
      liveChildProcesses.add(owner);
      retained = true;
      const stop = (): void => {
        void owner.retire().catch(reject);
      };
      args.signal?.addEventListener('abort', stop, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, args.timeoutMs);
      timeout.unref();
      const clearCallResources = (): void => {
        clearTimeout(timeout);
        args.signal?.removeEventListener('abort', stop);
      };
      void owner.start().then(
        (outcome) => {
          clearCallResources();
          resolve({ ...outcome, stderr, stdout, timedOut });
        },
        (error: unknown) => {
          clearCallResources();
          reject(error);
        }
      );
    } catch (error) {
      if (!retained) {
        args.releaseWorkspaceLease?.();
      }
      reject(error);
    }
  });
}

export function runDetachedProcess(args: ProcessArguments): Promise<SpawnOutcome> {
  if (process.platform === 'win32') {
    return runWindowsCommand(args);
  }
  const { argv, cwd, env, executable, timeoutMs, signal, streamer } = args;

  return new Promise<SpawnOutcome>((resolve, reject) => {
    // Already-aborted-before-spawn: honor it without ever starting the shell.
    // (e.g. the signal fired while resolveCommandCwd was awaiting realpath — a
    // listener added after the event would never fire.)
    if (signal?.aborted) {
      args.releaseWorkspaceLease?.();
      reject(new Error('Command aborted before execution.'));
      return;
    }

    let child: ChildProcess;
    try {
      const childEnvironment = commandEnvironment(env);
      // In the agent host the command inherits the Root's flock (ADR-0017).
      child = spawnNativeChild(executable, argv, {
        cwd,
        detached: true,
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Spawn failure (e.g. shell missing) is REPORTED, never swallowed.
      args.releaseWorkspaceLease?.();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const { pid } = child;
    if (pid === undefined) {
      args.releaseWorkspaceLease?.();
      reject(new Error('Failed to spawn shell process (no pid).'));
      return;
    }
    const closed = Promise.withResolvers<void>();
    const owner = {
      retire: () => {
        killProcessTree(pid, 'SIGKILL');
        return closed.promise;
      },
    };
    liveChildProcesses.add(owner);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let tornDown = false;
    let killTimer: NodeJS.Timeout | undefined;

    const emitStream = createBoundedShellStreamer(streamer);

    const appendBounded = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      emitStream(kind, text);
      if (kind === 'stdout') {
        if (stdoutBytes < MAX_CAPTURED_OUTPUT_BYTES) {
          stdout += text;
          stdoutBytes += chunk.byteLength;
        }
      } else if (stderrBytes < MAX_CAPTURED_OUTPUT_BYTES) {
        stderr += text;
        stderrBytes += chunk.byteLength;
      }
      // Past the cap we deliberately keep draining (the listener stays attached)
      // but stop appending, so the child never blocks on a full OS pipe buffer.
    };

    child.stdout?.on('data', (chunk: Buffer) => appendBounded('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendBounded('stderr', chunk));

    // Escalating teardown: polite SIGTERM, then SIGKILL after a grace window in
    // case the tree ignored SIGTERM. Always kills the GROUP, not just the shell.
    // Idempotent: a second trigger (timeout AND abort) must not overwrite
    // killTimer (which would leak the first SIGKILL timer) or re-SIGTERM.
    const tearDownTree = (): void => {
      if (tornDown) {
        return;
      }
      tornDown = true;
      killProcessTree(pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessTree(pid, 'SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = (): void => {
      tearDownTree();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      tearDownTree();
    }, timeoutMs);
    timeoutTimer.unref();

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener('abort', onAbort);
      liveChildProcesses.delete(owner);
      args.releaseWorkspaceLease?.();
      closed.resolve();
    };

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    // 'exit' fires when the SHELL process itself terminates — BEFORE the stdio
    // pipes close. If the command backgrounded work that inherited those pipes
    // (e.g. `sleep 60 &`), 'close' would otherwise wait for that grandchild to
    // finish (deferring the whole tool call). So when the shell exits on its OWN
    // (not via our teardown), reap the rest of the process group here: this kills
    // any background pipe-holder, which then lets 'close' fire promptly with the
    // captured output. Without this, a `&`-detached grandchild both stalls the
    // call AND survives the tool (the registry entry is deleted on close).
    // RESIDUAL GAP (documented, accepted): a deliberately daemonized grandchild
    // that left the group (setsid → reparents to PID 1) escapes this too — see
    // killProcessTree.
    child.on('exit', () => {
      if (!(settled || tornDown)) {
        killProcessTree(pid, 'SIGTERM');
      }
    });

    child.on('close', (code, closeSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        signal: closeSignal,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}

function runShellCommand(args: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  streamer: ShellOutputStreamer | undefined;
  releaseWorkspaceLease: () => void;
}): Promise<SpawnOutcome> {
  const { command, cwd, timeoutMs, signal, streamer } = args;
  const invocation = resolveShellInvocation(command);
  return runDetachedProcess({
    argv: invocation.args,
    cwd,
    executable: invocation.shell,
    releaseWorkspaceLease: args.releaseWorkspaceLease,
    signal,
    streamer,
    timeoutMs,
    windowsVerbatimArguments: process.platform === 'win32',
  });
}

/**
 * Build the visible omission marker separately so tests can pin the exact
 * model-facing contract and its character cost when output is budget-fitted.
 */
export function buildTruncationMarker(omittedChars: number, totalChars: number): string {
  return `[… output truncated: ${omittedChars} chars omitted of ${totalChars} total …]`;
}

/** True when `codeUnit` is the LEADING half of a UTF-16 surrogate pair. */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff;
}

/** True when `codeUnit` is the TRAILING half of a UTF-16 surrogate pair. */
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff;
}

/**
 * Keep early diagnostics and recent status from oversized output within one
 * hard character budget. Exported so the single-line slicing boundary and the
 * marker-inclusive size invariant can be tested without spawning a process.
 */
export function fitHeadAndTailToCharBudget(
  text: string,
  charBudget: number
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= charBudget) {
    return { text, truncated: false };
  }

  const boundedBudget = Math.max(0, Math.floor(charBudget));
  const totalChars = text.length;
  // N can never have more digits than M, so the N=M marker reserves the
  // maximum marker width before retained content receives the remaining room.
  const reservedMarkerLength = buildTruncationMarker(totalChars, totalChars).length;
  // A budget too small to even hold the marker cannot honestly retain any
  // content. Say so plainly instead of returning a mangled marker fragment —
  // the reservation below then guarantees the assembled result fits, so no
  // trailing defensive slice is needed.
  if (boundedBudget < reservedMarkerLength) {
    return { text: '', truncated: true };
  }
  const retainedBudget = boundedBudget - reservedMarkerLength;
  const headBudget = Math.floor(retainedBudget * 0.4);
  const tailBudget = retainedBudget - headBudget;
  const rawHead = text.slice(0, headBudget);
  // `slice` cuts UTF-16 code units, not characters — a boundary landing
  // inside a surrogate pair (emoji, CJK ext-B, ...) would otherwise leave a
  // lone surrogate that JSON.stringify escapes into a literal replacement
  // character. Snap the cut back off the pair instead of splitting it.
  const head =
    rawHead.length > 0 && isHighSurrogate(rawHead.charCodeAt(rawHead.length - 1))
      ? rawHead.slice(0, -1)
      : rawHead;
  const rawTail = tailBudget > 0 ? text.slice(-tailBudget) : '';
  const tail =
    rawTail.length > 0 && isLowSurrogate(rawTail.charCodeAt(0)) ? rawTail.slice(1) : rawTail;
  const omittedChars = totalChars - head.length - tail.length;
  const marker = buildTruncationMarker(omittedChars, totalChars);

  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
  };
}

/**
 * Truncation guidance attached whenever either stream was budget-fitted.
 * Describes the CURRENT head+tail retention shape — must never regress to
 * language that implies tail-only retention (e.g. advising `| tail -n N`,
 * which would discard the head content this feature exists to preserve).
 */
export const TRUNCATION_HINT =
  'Output was truncated to fit the budget; the start and end of each stream are shown with a marker where content was omitted (stdout prioritized). Re-run scoped to produce less output, or filter with grep/sed, if you need the omitted middle.';

/**
 * Bound captured output to the model token budget, keeping a 40% HEAD for early
 * diagnostics and a 60% TAIL for recent output and final status. ANSI escape
 * codes are stripped FIRST: test runners, builds, and git emit color/cursor
 * escapes that pollute the model-facing text and waste the token budget.
 *
 * FAIR SPLIT (deterministic, stdout-priority): the two streams are budgeted
 * INDEPENDENTLY so a chatty stderr (build/test progress is commonly on stderr)
 * can never starve the stdout result the model actually wants. stdout gets the
 * larger share of the per-stream budget and any leftover; stderr keeps a
 * guaranteed minimum share. Each non-empty stream then applies its own 40/60
 * character split, with the truncation marker charged to that same budget.
 *
 * SERIALIZED-SIZE CORRECTED: the nominal RAW content budget approximates the
 * transport guard, but JSON escaping can push the true SERIALIZED size over
 * it; when that happens this falls back to a bisection against the measured
 * serialized size (see the comment at that fallback for the full rationale).
 */
function buildResult(args: {
  command: string;
  cwd: string;
  durationMs: number;
  outcome: SpawnOutcome;
  rootId: string;
  rootName: string;
  topology: OpenRootTopology;
}): ExecuteCommandToolResult {
  const { command, cwd, durationMs, outcome, rootId, rootName, topology } = args;
  // Strip ANSI before budgeting so escape codes never reach the model or
  // consume the token budget.
  const stdoutText = stripAnsi(outcome.stdout);
  const stderrText = stripAnsi(outcome.stderr);

  // The echoed command can be up to the schema max (10k chars); bound it so it
  // cannot blow the result envelope (the model already knows what it sent).
  const echoedCommand =
    command.length > MAX_ECHOED_COMMAND_CHARS
      ? `${command.slice(0, MAX_ECHOED_COMMAND_CHARS)}… [command truncated: full command is in the tool call input]`
      : command;

  // Preserve the raw pre-ANSI guard: an ABSENT stream is never truncated. This
  // prevents a false "output was truncated" result for silent commands and the
  // common case where only one stream has content.
  const hasStdout = outcome.stdout.length > 0;
  const hasStderr = outcome.stderr.length > 0;

  // Reserve a small envelope for the base fields + hint, then split the rest:
  // stdout-priority (60%) with the remainder to stderr. If one stream is
  // empty, the other gets the whole content budget.
  const envelopeReserveChars = 1200;
  const nominalContentBudget = Math.max(0, NATIVE_TOOL_RESULT_CHAR_BUDGET - envelopeReserveChars);

  const buildForContentBudget = (contentBudget: number): ExecuteCommandToolResult => {
    let stdoutBudget: number;
    let stderrBudget: number;
    if (hasStdout && hasStderr) {
      stdoutBudget = Math.floor(contentBudget * 0.6);
      stderrBudget = contentBudget - stdoutBudget;
    } else if (hasStdout) {
      stdoutBudget = contentBudget;
      stderrBudget = 0;
    } else {
      stdoutBudget = 0;
      stderrBudget = contentBudget;
    }
    const fittedStdout = hasStdout
      ? fitHeadAndTailToCharBudget(stdoutText, stdoutBudget)
      : { text: '', truncated: false };
    const fittedStderr = hasStderr
      ? fitHeadAndTailToCharBudget(stderrText, stderrBudget)
      : { text: '', truncated: false };
    const truncated = fittedStdout.truncated || fittedStderr.truncated;
    return {
      ...topology,
      command: echoedCommand,
      cwd,
      durationMs,
      exitCode: outcome.exitCode,
      rootId,
      rootName,
      signal: outcome.signal,
      stderr: fittedStderr.text,
      stdout: fittedStdout.text,
      timedOut: outcome.timedOut,
      truncated,
      ...(truncated ? { hint: TRUNCATION_HINT } : {}),
    };
  };

  const nominalResult = buildForContentBudget(nominalContentBudget);
  if (JSON.stringify(nominalResult).length <= NATIVE_TOOL_RESULT_CHAR_BUDGET) {
    return nominalResult;
  }

  // The RAW content budget above assumes ~1 serialized char per retained
  // char, but JSON escaping expands `\n`/`"`/`\` to 2 chars each — a
  // newline-heavy stream (e.g. `seq`, one value per line) is enough to tip
  // the actual SERIALIZED size over NATIVE_TOOL_RESULT_CHAR_BUDGET even
  // though the raw estimate looked safe. Binary-search the content budget
  // against the REAL serialized size instead of guessing a fixed reserve —
  // same bisection-on-measured-size shape as fitContentTextToModelBudget in
  // packages/agent/src/tool-projection/tool-model-output.ts. Monotonic: a larger
  // content budget can only retain equal-or-more characters, so serialized
  // length is non-decreasing in contentBudget, which is what makes the
  // bisection valid. contentBudget=0 is the guaranteed-fits floor (envelope
  // only, both streams reduced to an empty budget-fitted string).
  let low = 0;
  let high = nominalContentBudget;
  let best = buildForContentBudget(0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = buildForContentBudget(mid);
    if (JSON.stringify(candidate).length <= NATIVE_TOOL_RESULT_CHAR_BUDGET) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Execute an arbitrary shell command in the workspace. THE highest-risk tool:
 * there is NO sandbox. Containment that actually exists here: the cwd is pinned
 * inside a workspace root, output is bounded, and the detached process-group
 * teardown guarantees no orphaned subprocess. The tool is registered like every
 * native tool and gated by the permission engine: with enforce-on-by-default,
 * 'execute' resolves to 'ask', so the run SUSPENDS for per-call approval before
 * this function is invoked (approve → run, decline → skip); allow/yolo runs it
 * unprompted, deny omits the tool. So this function assumes the caller (the
 * permission gate + approval flow) has already decided the command may run.
 */
export async function runExecuteCommand(
  input: ExecuteCommandInput,
  runtimeData: RuntimeData | undefined,
  options?: { signal?: AbortSignal | undefined; stream?: ShellOutputStreamer | undefined }
): Promise<ExecuteCommandToolResult> {
  const topology = describeOpenRootTopology(runtimeData);
  const { cwd, rootId, rootName, rootPath } = await resolveCommandCwd(
    runtimeData,
    input.root,
    input.cwd
  );
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const startedAt = Date.now();
  // Queueing is part of the same call budget; an expired waiter must never spawn.
  const deadline = AbortSignal.timeout(timeoutMs);
  const admissionSignal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let spawned = false;
  const outcome = await (async () => {
    const release = await acquireWorkspaceMutationLease(rootPath, 'opaque', admissionSignal);
    let transferred = false;
    try {
      admissionSignal.throwIfAborted();
      const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
      if (remainingTimeoutMs <= 0) {
        throw new ToolInputError(
          'The command timed out while waiting for workspace ownership; it was not run.'
        );
      }
      spawned = true;
      transferred = true;
      return await runShellCommand({
        command: input.command,
        cwd,
        releaseWorkspaceLease: release,
        signal: options?.signal,
        streamer: options?.stream,
        timeoutMs: remainingTimeoutMs,
      });
    } finally {
      if (!transferred) {
        release();
      }
    }
  })().catch((error: unknown) => {
    if (!spawned && admissionSignal.aborted) {
      throw new ToolInputError(
        options?.signal?.aborted
          ? 'The command was aborted before execution.'
          : 'The command timed out while waiting for workspace ownership; it was not run.'
      );
    }
    throw error;
  });
  const durationMs = Date.now() - startedAt;

  if (outcome.timedOut) {
    logger.warn('Command timed out and its process tree was killed', {
      command: REDACTED_COMMAND_LOG_VALUE,
      cwd: REDACTED_CWD_LOG_VALUE,
      durationMs,
      timeoutMs,
    });
  } else if (outcome.exitCode !== 0) {
    logger.info('Command exited non-zero', {
      command: REDACTED_COMMAND_LOG_VALUE,
      cwd: REDACTED_CWD_LOG_VALUE,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    });
  }

  return buildResult({
    command: input.command,
    cwd,
    durationMs,
    outcome,
    rootId,
    rootName,
    topology,
  });
}
