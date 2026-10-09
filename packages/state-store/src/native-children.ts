// Native processes a Root's host starts (ADR-0017). Each one inherits the Root's flock as an extra stdio slot, so a
// command that outlives a crashed host keeps the Root refused until it exits; an observer (desktop Main, the host's
// supervisor) learns each process's identity so it can end the process group after the host dies.
import { type ChildProcess, type SpawnOptions, type StdioOptions, spawn } from 'node:child_process';
import { processStartTime, sharedRootLeases } from './lock.js';

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
 * that never shared a lease (desktop Main, which owns its own children) spawns plainly.
 */
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
