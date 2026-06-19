import { type ChildProcess, spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { ExecuteCommandInput, RuntimeData } from '@brainstrike/agent';
import { fitItemsToCharBudget, NATIVE_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import treeKill from 'tree-kill';
import { resolveWorkspaceRoot } from './workspace-roots';

export const EXECUTE_COMMAND_TOOL_ID = 'brainstrike.executeCommand' as const;

const logger = createLogger('ExecuteCommandTool');

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
 * Spawn the user's shell with `-c command`, detached so the child leads its own
 * process group. Captures stdout/stderr up to {@link MAX_CAPTURED_OUTPUT_BYTES}.
 * On timeout OR abort, the WHOLE process tree is killed (SIGTERM then SIGKILL),
 * and the child is reaped from the global registry in `finally`.
 */
function runShellCommand(args: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}): Promise<SpawnOutcome> {
  const { command, cwd, timeoutMs, signal } = args;
  const shell = process.env['SHELL'] || '/bin/sh';

  return new Promise<SpawnOutcome>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, ['-c', command], {
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
    const tearDownTree = (): void => {
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

/**
 * Bound captured output to the model token budget, keeping the TAIL (the most
 * recent lines — where errors and final status live). Splits both streams into
 * lines and fits the largest tail-biased prefix that serializes within budget.
 */
function buildResult(args: {
  command: string;
  cwd: string;
  durationMs: number;
  outcome: SpawnOutcome;
}): ExecuteCommandToolResult {
  const { command, cwd, durationMs, outcome } = args;
  // Tail bias: reverse so fitItemsToCharBudget keeps the prefix of the REVERSED
  // list (i.e. the LAST lines of the real output), then un-reverse for display.
  const stdoutLines = outcome.stdout.split('\n');
  const stderrLines = outcome.stderr.split('\n');
  const reversedTail = [
    ...stderrLines.map((line) => ({ stream: 'stderr' as const, line })).reverse(),
    ...stdoutLines.map((line) => ({ stream: 'stdout' as const, line })).reverse(),
  ];

  const base = {
    command,
    cwd,
    durationMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
  };

  const { kept, result } = fitItemsToCharBudget(
    reversedTail,
    (lines): ExecuteCommandToolResult => {
      const keptStdout = lines
        .filter((entry) => entry.stream === 'stdout')
        .reverse()
        .map((entry) => entry.line)
        .join('\n');
      const keptStderr = lines
        .filter((entry) => entry.stream === 'stderr')
        .reverse()
        .map((entry) => entry.line)
        .join('\n');
      const truncated = lines.length < reversedTail.length;
      return {
        ...base,
        stdout: keptStdout,
        stderr: keptStderr,
        truncated,
        ...(truncated
          ? {
              hint: 'Output was truncated to fit the budget; only the most recent lines are shown. Re-run piping through "| tail -n N", or scope the command to produce less output.',
            }
          : {}),
      };
    },
    NATIVE_TOOL_RESULT_CHAR_BUDGET
  );

  // Defensive: if even zero lines somehow overflow (impossible in practice), the
  // fitter returns its build([]) result, which is already budget-shaped.
  void kept;
  return result;
}

/**
 * Execute an arbitrary shell command in the workspace. THE highest-risk tool:
 * there is NO sandbox. Safety comes from the permission engine (execute-risk +
 * requiresApproval gating), the cwd containment, the bounded output, and the
 * detached process-group teardown that guarantees no orphaned subprocess.
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
      command: input.command,
      cwd,
      timeoutMs,
      durationMs,
    });
  } else if (outcome.exitCode !== 0) {
    logger.info('Command exited non-zero', {
      command: input.command,
      cwd,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    });
  }

  return buildResult({ command: input.command, cwd, durationMs, outcome });
}
