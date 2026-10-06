import { type ChildProcess, fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { ForeignLockError, RootLock, RootLockedError } from '@brainstrike/state-store';
import type { HostSpawner } from './launcher.js';
import { ResourceOwner } from './resource-owner.js';
import { decodeStartOptions } from './runtime.js';
import { decodeStartupMessage, type StartupMessage } from './startup-message.js';
export interface NodeSpawnerOptions {
  /** Trusted shell composition inputs, appended after the validated start options. */
  readonly entryArgs?: readonly string[];
  readonly entrypoint?: string;
  readonly execArgv?: readonly string[];
  /** Detached clients must not keep a short-lived CLI's output pipes open. */
  readonly output?: 'inherit' | 'ignore';
}
async function disconnect(child: ChildProcess): Promise<void> {
  if (child.connected) {
    await new Promise<void>((resolve) => {
      child.once('disconnect', resolve);
      child.disconnect();
    });
  }
  child.unref();
}
function startupFailure(
  root: string,
  message: Extract<StartupMessage, { readonly event: 'failed' }>
): Error {
  const lease = RootLock.inspect(root)?.owner;
  if (message.kind === 'root-locked' && lease && !lease.released) {
    return new RootLockedError(lease);
  }
  if (message.kind === 'foreign-lock' && lease) {
    return new ForeignLockError(lease);
  }
  return new Error(message.message);
}
export function createNodeHostSpawner(options: NodeSpawnerOptions = {}): HostSpawner {
  const entrypoint =
    options.entrypoint ?? fileURLToPath(new URL('./process-entry.js', import.meta.url));
  return async (input, signal): Promise<void> => {
    signal.throwIfAborted();
    const startOptions = decodeStartOptions(input);
    const owner = new ResourceOwner();
    let ready = false;
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
      async (child) => {
        if (!ready && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve, reject) => {
            child.once('exit', () => resolve());
            child.once('error', reject);
            child.kill('SIGTERM');
          });
        }
        await disconnect(child);
      }
    );
    try {
      await runWithTimeout(
        (signal) =>
          new Promise<void>((resolve, reject) => {
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
                  ready = true;
                  cleanup();
                  resolve();
                  return;
                }
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
          timeoutMs: 10_000,
        }
      );
    } finally {
      await owner.close();
    }
  };
}
