// Native processes a Root's host starts (ADR-0017). Each one inherits the Root's flock as an extra stdio slot, so a
// command that outlives a crashed host keeps the Root refused until it exits; an observer (desktop Main, the host's
// supervisor) learns each process's identity so it can end the process group after the host dies.
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
  type StdioOptions,
  spawn,
} from 'node:child_process';
import treeKill from 'tree-kill';
import { processStartTime, sharedRootLeases } from './lock.ts';

/**
 * ADR-0030: the only two lifecycle clocks for a child process. A child we own that speaks our close
 * protocol gets `CHILD_CLOSE_BUDGET_MS` from the close request to its exit before it is killed.
 * A killed or signalled child gets `CHILD_SIGNAL_GRACE_MS`: SIGTERM escalates to SIGKILL after
 * it, and an exit still pending after it is logged. Either way the exit is still joined.
 */
export const CHILD_CLOSE_BUDGET_MS = 30_000;
export const CHILD_SIGNAL_GRACE_MS = 2000;

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
      if (error && processStartTime(pid) !== null) {
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

/** One supervised native process. `group`: it leads its own process group, which is signalled as a whole. */
export interface NativeChild {
  readonly group: boolean;
  readonly pid: number;
  readonly start: string;
}
export interface NativeChildObserver {
  exited(child: NativeChild): void;
  started(child: NativeChild): void;
}

let observer: NativeChildObserver | undefined;

/** The host's supervisor hears about every native process this process starts; returns the unsubscribe. */
export function observeNativeChildren(next: NativeChildObserver): () => void {
  if (observer) {
    throw new Error('Native children already have an observer');
  }
  observer = next;
  return () => {
    if (observer === next) {
      observer = undefined;
    }
  };
}

/** Reports `pid` when an observer is listening; the returned function reports its exit, once. */
function supervise(pid: number | undefined, group: boolean): () => void {
  const current = observer;
  if (!current || pid === undefined) {
    return () => undefined;
  }
  const start = processStartTime(pid);
  if (start === null) {
    return () => undefined; // it already exited: nothing is left to supervise
  }
  const child: NativeChild = { group, pid, start };
  current.started(child);
  let exited = false;
  return () => {
    if (!exited) {
      exited = true;
      current.exited(child);
    }
  };
}

function stdioSlots(stdio: StdioOptions | undefined): Exclude<StdioOptions, string> {
  if (stdio === undefined || typeof stdio === 'string') {
    return [stdio, stdio, stdio];
  }
  // Undefined slots 0-2 keep Node's default pipe, so the Root's descriptor never lands on stdin/stdout/stderr.
  return [...stdio, ...Array.from({ length: Math.max(0, 3 - stdio.length) }, () => undefined)];
}

/**
 * `child_process.spawn` for every native process a host starts. While this process shares a held Root lease, the
 * child inherits the Root's flock (POSIX) in the first stdio slot after the ones given. Once every shared lease was
 * released the spawn is refused, and so is a spawn that would have to choose between several held leases. A process
 * that never shared a lease (desktop Main, which owns its own children) spawns plainly. Like `spawn`, piped stdio
 * keeps its streams: the Root's descriptor only ever takes a slot after them.
 */
export function spawnNativeChild(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams;
export function spawnNativeChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess;
export function spawnNativeChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  const shared = sharedRootLeases();
  const held = shared.filter((lease) => !lease.isReleased);
  if (held.length > 1) {
    throw new Error(
      'This process holds several shared Root leases; a native process belongs to one'
    );
  }
  if (shared.length > 0 && held.length === 0) {
    throw new Error('The Root lease is released; no native process may start under it');
  }
  const fd = held[0]?.inheritableFd;
  const child = spawn(command, args, {
    ...options,
    ...(fd === undefined ? {} : { stdio: [...stdioSlots(options.stdio), fd] }),
  });
  child.once('exit', supervise(child.pid, options.detached === true));
  return child;
}

/**
 * A native process a vendor API started (node-pty, the MCP SDK's stdio transport, `execFile`). Those APIs cannot pass
 * an extra descriptor, so the process does not hold the Root (an ADR-0017 limit); the observer still supervises it.
 * Call the returned function when it exits.
 */
export function trackNativeChild(
  pid: number | undefined,
  options: { readonly group: boolean }
): () => void {
  return supervise(pid, options.group);
}
