import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { ForeignLockError, RootLock, RootLockedError } from '@brainstrike/state-store';
import type { HostSpawner } from './launcher.js';
import { ResourceOwner } from './resource-owner.js';
import { decodeStartOptions } from './runtime.js';
import { decodeStartupMessage, type StartupMessage } from './startup-message.js';
export interface NodeSpawnerOptions {
  readonly entrypoint?: string;
  readonly execArgv?: readonly string[];
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
    const child = await owner.acquire(
      async () =>
        fork(entrypoint, [JSON.stringify(startOptions)], {
          detached: startOptions.lifetime === 'persistent',
          execArgv: [...(options.execArgv ?? [])],
          execPath: process.execPath,
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        }),
      disconnect
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
