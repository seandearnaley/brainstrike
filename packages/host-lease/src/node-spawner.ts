import { type ChildProcess, fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import type { HostSpawner, StartedHost } from './launcher.js';
import { ResourceOwner } from './resource-owner.js';
import { decodeStartOptions, type HostLifetime } from './runtime.js';
import { startupFailure } from './startup-failure.js';
import { decodeStartupMessage } from './startup-message.js';
export interface NodeSpawnerOptions {
  /** Trusted shell composition inputs, appended after the validated start options. */
  readonly entryArgs?: readonly string[];
  readonly entrypoint?: string;
  readonly execArgv?: readonly string[];
  /** Detached clients must not keep a short-lived CLI's output pipes open. */
  readonly output?: 'inherit' | 'ignore';
  /**
   * Narrows the startup-report deadline, and with it a cancelled host's exit
   * bound, for lifecycle tests; production keeps
   * `HOST_STARTER_READY_TIMEOUT_MS` and `HOST_STARTER_CANCEL_EXIT_TIMEOUT_MS`.
   */
  readonly readyTimeoutMs?: number;
}
/** How long a starter has to report ready (or a failure) before it is cancelled. */
export const HOST_STARTER_READY_TIMEOUT_MS = 30_000;
/**
 * Once cancelled or retired, how long a host has to exit before it is killed.
 * Its own bound (BST-2176): a longer readiness deadline never lengthens a
 * failed launch's cleanup.
 */
export const HOST_STARTER_CANCEL_EXIT_TIMEOUT_MS = 10_000;
async function closeChannel(child: ChildProcess): Promise<void> {
  if (child.connected) {
    await new Promise<void>((resolve) => {
      child.once('disconnect', resolve);
      child.disconnect();
    });
  }
}
/** The child's exit; registered before it is asked to stop, so it cannot be missed. */
function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => child.once('exit', () => resolve()));
}
/**
 * The bounded last resort: SIGKILL the host's whole process group when it
 * leads one (a POSIX detached host), otherwise only the host. On Windows
 * `kill` is TerminateProcess, and the host's kill-on-close Job ends its
 * descendants (ADR-0017).
 */
function terminate(child: ChildProcess, groupLeader: boolean): void {
  if (groupLeader && process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (cause) {
      // ESRCH: the group is gone; EPERM: Darwin's answer while only zombies
      // remain. Either way the leader's own exit below is still joined.
      const code = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
      if (code !== 'ESRCH' && code !== 'EPERM') {
        throw cause;
      }
    }
  }
  child.kill('SIGKILL');
}
/**
 * Stop a host this starter still owns and join its exit (BST-2167). Asking is
 * the graceful path: `cancel-startup` over the IPC lane to a host that holds
 * its root, else SIGTERM; either way the host closes itself. A host still
 * running `timeoutMs` later is SIGKILLed, then joined, and the stop rejects
 * naming its pid: a forced kill never passes as a clean retirement.
 */
async function stopAndJoin(
  child: ChildProcess,
  ask: 'cancel-startup' | 'SIGTERM',
  groupLeader: boolean,
  timeoutMs: number
): Promise<void> {
  const exit = exitOf(child);
  const errored = Promise.withResolvers<never>();
  errored.promise.catch(() => undefined); // observed by the races below
  child.on('error', errored.reject);
  try {
    if (ask === 'cancel-startup') {
      await new Promise<void>((resolve, reject) => {
        child.send({ event: 'cancel-startup' }, (cause: Error | null) =>
          cause ? reject(cause) : resolve()
        );
      });
    } else {
      child.kill('SIGTERM');
    }
    // A host waits for its parent to let go of the IPC channel before it exits.
    await closeChannel(child);
    const outlived = new Error(
      `Host pid ${child.pid} was still running ${timeoutMs} ms after ${ask}; it was killed`
    );
    try {
      await runWithTimeout(() => Promise.race([exit, errored.promise]), {
        onTimeout: () => outlived,
        timeoutMs,
      });
      return;
    } catch (cause) {
      if (cause !== outlived) {
        throw cause;
      }
    }
    terminate(child, groupLeader);
    await Promise.race([exit, errored.promise]);
    throw outlived;
  } finally {
    child.off('error', errored.reject);
  }
}
/** What a starter knows about the child it owns when it lets go of it. */
interface StarterState {
  /** How long a cancelled or retired host has to exit before it is killed. */
  readonly exitTimeoutMs: number;
  failedWithRetainedOwner: boolean;
  readonly groupLeader: boolean;
  ready: boolean;
  released: boolean;
  readonly root: string;
}
/**
 * BST-2176: the PID and OS start time a ready child's root lease names. Read
 * before this starter has observed its exit, so the child is unreaped and the
 * pid is still its own; a zombie has no start time.
 */
function readyIdentity(child: ChildProcess): StartedHost['identity'] {
  const start = child.pid === undefined ? null : processStartTime(child.pid);
  if (child.pid === undefined || start === null) {
    throw new Error(`Host starter pid ${child.pid} exited as it reported ready`);
  }
  return { pid: child.pid, start };
}
/** The launch attached: hand the host the lifetime it was started with. */
async function handOff(child: ChildProcess, lifetime: HostLifetime): Promise<void> {
  if (lifetime === 'app') {
    // ADR-0017: an app host lives exactly as long as this channel, which closes when this
    // process dies. Unref'd, it never keeps the launcher alive.
    child.channel?.unref();
    child.unref();
    return;
  }
  await closeChannel(child);
  child.unref();
}
/** A host that never became ready, or one its launch gave up on (BST-2167). */
async function retire(child: ChildProcess, state: StarterState): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closeChannel(child);
    child.unref();
    return;
  }
  const lease = RootLock.inspect(state.root)?.owner;
  const ownsRoot =
    lease !== undefined &&
    !lease.released &&
    lease.pid === child.pid &&
    processStartTime(lease.pid) === lease.start;
  if (ownsRoot && state.failedWithRetainedOwner) {
    // BST-1977 startup repro: SIGTERM killed an owner whose descendant could
    // not join. A host that reported its failed join retains the actual
    // process and root; its report is the visible failure.
    await closeChannel(child);
    child.unref();
    return;
  }
  const ask = ownsRoot && child.connected ? 'cancel-startup' : 'SIGTERM';
  await stopAndJoin(child, ask, state.groupLeader, state.exitTimeoutMs);
  // A ready host that closed cleanly exits 0; anything else is a failed close.
  if (state.ready && child.exitCode !== 0) {
    throw new Error(
      `Host pid ${child.pid} did not close cleanly after ${ask} (${child.exitCode ?? child.signalCode})`
    );
  }
}
export function createNodeHostSpawner(options: NodeSpawnerOptions = {}): HostSpawner {
  const entrypoint =
    options.entrypoint ?? fileURLToPath(new URL('./process-entry.js', import.meta.url));
  const readyTimeoutMs = options.readyTimeoutMs ?? HOST_STARTER_READY_TIMEOUT_MS;
  if (!(Number.isSafeInteger(readyTimeoutMs) && readyTimeoutMs > 0)) {
    throw new RangeError('Host starter readiness deadline must be a positive safe integer');
  }
  // A narrowed readiness deadline narrows the exit bound too, never widens it.
  const exitTimeoutMs = Math.min(readyTimeoutMs, HOST_STARTER_CANCEL_EXIT_TIMEOUT_MS);
  return async (input, signal): Promise<StartedHost> => {
    signal.throwIfAborted();
    const startOptions = decodeStartOptions(input);
    const owner = new ResourceOwner();
    const state: StarterState = {
      exitTimeoutMs,
      failedWithRetainedOwner: false,
      // POSIX `detached` makes the child its own process group's leader.
      groupLeader: process.platform !== 'win32' && startOptions.lifetime === 'persistent',
      ready: false,
      released: false,
      root: startOptions.root,
    };
    const child = await owner.acquire(
      async (): Promise<ChildProcess> => {
        if (process.platform === 'win32') {
          // Windows non-detached children die with the creator's libuv job.
          // HostRuntime must instead join CLI idle/app-parent cleanup itself.
          // https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c
          // spawn exposes windowsHide and, like fork, creates Node's IPC fd.
          return spawn(
            process.execPath,
            [
              ...(options.execArgv ?? []),
              entrypoint,
              JSON.stringify(startOptions),
              ...(options.entryArgs ?? []),
            ],
            {
              detached: true,
              stdio: ['ignore', options.output ?? 'inherit', options.output ?? 'inherit', 'ipc'],
              windowsHide: true,
            }
          );
        }
        return fork(entrypoint, [JSON.stringify(startOptions), ...(options.entryArgs ?? [])], {
          detached: startOptions.lifetime === 'persistent',
          execArgv: [...(options.execArgv ?? [])],
          execPath: process.execPath,
          stdio: ['ignore', options.output ?? 'inherit', options.output ?? 'inherit', 'ipc'],
        });
      },
      (child) => (state.released ? handOff(child, startOptions.lifetime) : retire(child, state))
    );
    let identity: StartedHost['identity'];
    try {
      identity = await runWithTimeout(
        (signal) =>
          new Promise<StartedHost['identity']>((resolve, reject) => {
            const cleanup = (): void => {
              child.off('message', message);
              child.off('exit', exited);
              child.off('error', failed);
              signal.removeEventListener('abort', aborted);
            };
            const failed = (cause: unknown): void => {
              cleanup();
              reject(cause);
            };
            const exited = (code: number | null, exitSignal: NodeJS.Signals | null): void =>
              failed(
                new Error(
                  `Host starter pid ${child.pid} exited before ready (${code ?? exitSignal})`
                )
              );
            const aborted = (): void => failed(signal.reason);
            const message = (inputMessage: unknown): void => {
              try {
                const decoded = decodeStartupMessage(inputMessage);
                if (decoded.event === 'ready') {
                  const identity = readyIdentity(child);
                  state.ready = true;
                  cleanup();
                  resolve(identity);
                  return;
                }
                state.failedWithRetainedOwner = decoded.ownership === 'retained';
                failed(startupFailure(startOptions.root, decoded));
              } catch (cause) {
                failed(cause);
              }
            };
            child.on('message', message);
            child.once('exit', exited);
            child.once('error', failed);
            signal.addEventListener('abort', aborted, { once: true });
          }),
        {
          onTimeout: () => new Error(`Host starter pid ${child.pid} did not become ready`),
          signal,
          timeoutMs: readyTimeoutMs,
        }
      );
    } catch (cause) {
      try {
        await owner.close();
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], 'Host startup and cancellation failed', {
          cause,
        });
      }
      throw cause;
    }
    // BST-2167: the launch, not this starter, decides the ready host's fate.
    return {
      identity,
      release: () => {
        state.released = true;
        return owner.close();
      },
      retire: () => owner.close(),
    };
  };
}
