// Ending the native processes a host starts. None of them holds the Root (ADR-0031): its lock is the host's alone.
import type { ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';

/**
 * ADR-0030: the only two lifecycle clocks for a child process. A child we own that speaks our close
 * protocol gets `CHILD_CLOSE_BUDGET_MS` from the close request to its exit before it is killed.
 * A killed or signalled child gets `CHILD_SIGNAL_GRACE_MS`: SIGTERM escalates to SIGKILL after
 * it, and an exit still pending after it is logged. Either way the exit is still joined.
 */
export const CHILD_CLOSE_BUDGET_MS = 30_000;
export const CHILD_SIGNAL_GRACE_MS = 2000;

/** kill(pid, 0): ESRCH = gone; EPERM = exists (another user's process). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ends `pid` and every process under it, then settles. On Windows a kill stops only the program
 * it names, so a launcher or shim (`cmd\\git.exe`, a Chocolatey `rg`) would leave its real program
 * running; `tree-kill` runs `taskkill /T /F` there and walks the process table on POSIX. Call it
 * while `pid` is still running: a tree whose root already exited has nothing left to walk.
 */
export function terminateTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, 'SIGKILL', (error) => {
      // A tree that ended on its own first is the outcome asked for, not a failure.
      if (error && isRunning(pid)) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** The deadline of one bounded child, from {@link endTreeOnDeadline}. */
export interface ChildDeadline {
  /** Stops the clock and the abort listener; call it once the child has exited. */
  clear(): void;
  /** The deadline or the abort ended the child's tree. */
  readonly ended: boolean;
  /** The deadline, not the abort, ended the child's tree. */
  readonly timedOut: boolean;
}

/**
 * Ends `child`'s whole tree when `timeoutMs` passes or `signal` aborts. Use it instead of the `timeout` and `signal`
 * options of `spawn` and `execFile`, whose kill stops only the program Node started: on Windows that may be a launcher
 * or shim with the real program still running under it (ADR-0030). A failed termination goes to `onError`.
 */
export function endTreeOnDeadline(
  child: ChildProcess,
  options: {
    readonly onError: (cause: unknown) => void;
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs: number;
  }
): ChildDeadline {
  let ended = false;
  let timedOut = false;
  const end = (): boolean => {
    if (ended || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    ended = true;
    terminateTree(child.pid).catch(options.onError);
    return true;
  };
  const timer = setTimeout(() => {
    timedOut = end();
  }, options.timeoutMs);
  const { signal } = options;
  const abort = (): void => {
    end();
  };
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }
  return {
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
    get ended() {
      return ended;
    },
    get timedOut() {
      return timedOut;
    },
  };
}
