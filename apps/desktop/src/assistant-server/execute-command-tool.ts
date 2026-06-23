import { type ChildProcess, spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { ExecuteCommandInput, RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import stripAnsi from 'strip-ansi';
import treeKill from 'tree-kill';
import { resolveWorkspaceRoot } from './workspace-roots';

export const EXECUTE_COMMAND_TOOL_ID = 'brainstrike.executeCommand' as const;

const logger = createLogger('ExecuteCommandTool');
const REDACTED_COMMAND_LOG_VALUE = { redacted: true } as const;
const REDACTED_CWD_LOG_VALUE = { redacted: true } as const;

/** Default per-command timeout when the model does not specify one. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling on the per-call timeout so a bad value cannot wedge the host. */
const MAX_TIMEOUT_MS = 600_000;
/**
 * Hard ceiling on RAW captured output bytes. Independent of (and larger than)
 * the model-facing token budget: this stops a runaway command from filling
 * memory, while {@link NATIVE_TOOL_RESULT_CHAR_BUDGET} bounds what the model
 * actually sees. Once hit we keep draining the pipes (so the child never blocks
 * on a full buffer) but stop appending.
 */
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
/**
 * Grace period between the polite SIGTERM and the forceful SIGKILL when tearing
 * down a process tree. A well-behaved child exits on SIGTERM; a wedged one is
 * reaped by the follow-up SIGKILL.
 */
const KILL_GRACE_MS = 2000;

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
    return { shell, args: ['/d', '/s', '/c', command] };
  }
  const shell = process.env['SHELL'] || '/bin/sh';
  return { shell, args: ['-c', command] };
}

export interface ExecuteCommandToolResult {
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
  /** Terminating signal name when the process was killed (else null). */
  signal: string | null;
  /** Budget-fitted tail of captured stderr (most-recent lines win). */
  stderr: string;
  /** Budget-fitted tail of captured stdout (most-recent lines win). */
  stdout: string;
  /** True when the command was killed because it exceeded its timeout. */
  timedOut: boolean;
  /** True when stdout/stderr were trimmed to fit the model output budget. */
  truncated: boolean;
}

/**
 * GLOBAL registry of live child processes spawned by this tool, keyed by pid.
 *
 * Every spawned child is added on start and removed in the `finally` of its own
 * run. {@link disposeLiveChildProcesses} reaps anything still live so a desktop
 * shutdown / factory reset can never leak a `vitest`/build process that keeps
 * eating CPU and battery after the app is gone. Module-level so it is shared by
 * every concurrent tool call in the process.
 */
const liveChildProcesses = new Map<number, ChildProcess>();

/**
 * Kill an entire detached process tree.
 *
 * The child is spawned `detached: true`, so it is the leader of its own process
 * group and `process.kill(-pid, signal)` signals the WHOLE group (the shell AND
 * every grandchild it forked) in one call — the orphan-prevention guarantee.
 * `tree-kill` is the cross-platform backstop (it walks the child tree itself and
 * is the only mechanism on Windows, which has no negative-pid groups). A kill
 * failure is logged, never swallowed (no-silent-fallbacks).
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
  let groupKilled = false;
  try {
    // Negative pid → signal the whole process group (POSIX). Requires the child
    // to have been spawned detached so it leads its own group.
    process.kill(-pid, signal);
    groupKilled = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH = the group is already gone (normal once the child has exited).
    if (code !== 'ESRCH') {
      logger.warn('Process-group kill failed; falling back to tree-kill', {
        pid,
        signal,
        code,
      });
    }
  }
  // Always also run tree-kill: it covers Windows (no process groups) and any
  // grandchild that escaped the group (rare, but the recipe is belt-and-braces).
  treeKill(pid, signal, (error) => {
    // Only log when the group kill ALSO did not land and the failure is not the
    // expected "already dead" race after a successful kill (no-silent-fallbacks).
    if (!groupKilled && error && !/no such process/i.test(error.message)) {
      logger.warn('tree-kill failed', { pid, signal, error: error.message });
    }
  });
}

/**
 * Reap every still-live child spawned by this tool. Wired into the desktop
 * shutdown / factory-reset lifecycle so no orphaned subprocess survives the app.
 * Returns the number of trees it signalled (for logging/observability).
 */
export function disposeLiveChildProcesses(): number {
  const pids = Array.from(liveChildProcesses.keys());
  for (const pid of pids) {
    killProcessTree(pid, 'SIGKILL');
  }
  liveChildProcesses.clear();
  if (pids.length > 0) {
    logger.info('Reaped live shell child processes on dispose', { count: pids.length });
  }
  return pids.length;
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
): Promise<string> {
  const root = resolveWorkspaceRoot(runtimeData, rootQualifier);
  const canonicalRootPath = await fsPromises.realpath(root.path);
  if (requestedCwd === undefined || requestedCwd.trim().length === 0) {
    return canonicalRootPath;
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
      throw new Error(`cwd "${requestedCwd}" does not exist.`);
    }
    throw error;
  }
  const relativeFromRoot = path.relative(canonicalRootPath, canonicalCwd);
  const withinRoot =
    canonicalCwd === canonicalRootPath ||
    (relativeFromRoot.length > 0 &&
      !relativeFromRoot.startsWith('..') &&
      !path.isAbsolute(relativeFromRoot));
  if (!withinRoot) {
    throw new Error(
      `cwd "${requestedCwd}" resolves outside the workspace root "${root.displayName}". A command's start directory must be inside an open folder.`
    );
  }
  return canonicalCwd;
}

interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

/**
 * Spawn the user's platform shell (see {@link resolveShellInvocation}), detached
 * so the child leads its own process group. Captures stdout/stderr up to
 * {@link MAX_CAPTURED_OUTPUT_BYTES}. On timeout OR abort, the WHOLE process tree
 * is killed (SIGTERM then SIGKILL); on a clean shell exit any background work it
 * left running is best-effort group-reaped. The child is always removed from the
 * global registry in `cleanup` (run from the close/error handlers).
 */
function runShellCommand(args: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}): Promise<SpawnOutcome> {
  const { command, cwd, timeoutMs, signal } = args;
  const { shell, args: shellArgs } = resolveShellInvocation(command);

  return new Promise<SpawnOutcome>((resolve, reject) => {
    // Already-aborted-before-spawn: honor it without ever starting the shell.
    // (e.g. the signal fired while resolveCommandCwd was awaiting realpath — a
    // listener added after the event would never fire.)
    if (signal?.aborted) {
      reject(new Error('Command aborted before execution.'));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Discourage interactive prompts that would hang a non-interactive run.
          // biome-ignore lint/style/useNamingConvention: CI is a standard env var name (must be uppercase).
          CI: 'true',
        },
      });
    } catch (error) {
      // Spawn failure (e.g. shell missing) is REPORTED, never swallowed.
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const { pid } = child;
    if (pid === undefined) {
      reject(new Error('Failed to spawn shell process (no pid).'));
      return;
    }
    liveChildProcesses.set(pid, child);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let tornDown = false;
    let killTimer: NodeJS.Timeout | undefined;

    const appendBounded = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
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
      liveChildProcesses.delete(pid);
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
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

/** Keep the largest TAIL (last N lines) of `lines` that fits `charBudget`. */
function fitTailToCharBudget(
  lines: readonly string[],
  charBudget: number
): {
  text: string;
  truncated: boolean;
} {
  if (charBudget <= 0 || lines.length === 0) {
    return { text: '', truncated: lines.length > 0 };
  }
  // Walk from the LAST line backwards, accumulating until the next line would
  // overflow. +1 per joined newline.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > charBudget) {
      break;
    }
    kept.push(line);
    used += cost;
  }
  kept.reverse();
  return { text: kept.join('\n'), truncated: kept.length < lines.length };
}

/**
 * Bound captured output to the model token budget, keeping the TAIL (the most
 * recent lines — where errors and final status live). ANSI escape codes are
 * stripped FIRST: test runners, builds, and git emit color/cursor escapes that
 * pollute the model-facing text and waste the token budget.
 *
 * FAIR SPLIT (deterministic, stdout-priority): the two streams are budgeted
 * INDEPENDENTLY so a chatty stderr (build/test progress is commonly on stderr)
 * can never starve the stdout result the model actually wants. stdout gets the
 * larger share of the per-stream budget and any leftover; stderr keeps a
 * guaranteed minimum tail. Each stream then keeps its own most-recent lines.
 */
function buildResult(args: {
  command: string;
  cwd: string;
  durationMs: number;
  outcome: SpawnOutcome;
}): ExecuteCommandToolResult {
  const { command, cwd, durationMs, outcome } = args;
  // Strip ANSI before line-splitting/budgeting so escape codes never reach the
  // model or consume the token budget.
  const stdoutLines = stripAnsi(outcome.stdout).split('\n');
  const stderrLines = stripAnsi(outcome.stderr).split('\n');

  // The echoed command can be up to the schema max (10k chars); bound it so it
  // cannot blow the result envelope (the model already knows what it sent).
  const MaxEchoedCommandChars = 500;
  const echoedCommand =
    command.length > MaxEchoedCommandChars
      ? `${command.slice(0, MaxEchoedCommandChars)}…`
      : command;

  // Reserve a small envelope for the base fields + hint, then split the rest:
  // stdout-priority (60%) with the remainder to stderr. If one stream is empty,
  // the other gets the whole content budget.
  const envelopeReserveChars = 1200;
  const contentBudget = Math.max(0, NATIVE_TOOL_RESULT_CHAR_BUDGET - envelopeReserveChars);
  const hasStdout = outcome.stdout.length > 0;
  const hasStderr = outcome.stderr.length > 0;
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

  // An ABSENT stream is `''`, which `.split('\n')` turns into `['']` (one empty
  // line, length 1 — NOT `[]`). Fitting that under the stream's 0 budget would
  // count the empty line as dropped and report truncated:true — a false "output
  // was truncated" on the COMMON case (a silent command, or output on only one
  // stream). Only fit streams that actually have content; an absent stream is
  // never truncated.
  const fittedStdout = hasStdout
    ? fitTailToCharBudget(stdoutLines, stdoutBudget)
    : { text: '', truncated: false };
  const fittedStderr = hasStderr
    ? fitTailToCharBudget(stderrLines, stderrBudget)
    : { text: '', truncated: false };
  const truncated = fittedStdout.truncated || fittedStderr.truncated;

  return {
    command: echoedCommand,
    cwd,
    durationMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    stdout: fittedStdout.text,
    stderr: fittedStderr.text,
    truncated,
    ...(truncated
      ? {
          hint: 'Output was truncated to fit the budget; only the most recent lines of each stream are shown (stdout prioritized). Re-run piping through "| tail -n N", or scope the command to produce less output.',
        }
      : {}),
  };
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
  options?: { signal?: AbortSignal | undefined }
): Promise<ExecuteCommandToolResult> {
  const cwd = await resolveCommandCwd(runtimeData, input.root, input.cwd);
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const startedAt = Date.now();
  const outcome = await runShellCommand({
    command: input.command,
    cwd,
    timeoutMs,
    signal: options?.signal,
  });
  const durationMs = Date.now() - startedAt;

  if (outcome.timedOut) {
    logger.warn('Command timed out and its process tree was killed', {
      command: REDACTED_COMMAND_LOG_VALUE,
      cwd: REDACTED_CWD_LOG_VALUE,
      timeoutMs,
      durationMs,
    });
  } else if (outcome.exitCode !== 0) {
    logger.info('Command exited non-zero', {
      command: REDACTED_COMMAND_LOG_VALUE,
      cwd: REDACTED_CWD_LOG_VALUE,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    });
  }

  return buildResult({ command: input.command, cwd, durationMs, outcome });
}
