import { attachAgentHost } from '@brainstrike/agent-host/client';
import { runAtPromiseBoundary, runWithTimeout } from '@brainstrike/effect-kit';
import {
  decodeStartupMessage,
  type HostAttachment,
  type HostStartOptions,
  launchHost,
  type StartupMessage,
} from '@brainstrike/host-lease';
import { ForeignLockError, RootLock, RootLockedError } from '@brainstrike/state-store';
import { Effect, Exit, Scope } from 'effect';
import { utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import type { HostLeaseControl } from './host-lease-control';

export interface HostLeaseUtilityProcess {
  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  readonly pid: number | undefined;
  postMessage(message: HostLeaseControl): void;
}
export type HostLeaseFork = (
  entrypoint: string,
  args: readonly string[]
) => HostLeaseUtilityProcess;
export interface DesktopHostLeaseOptions {
  readonly closeTimeoutMs?: number;
  readonly entryPath?: string;
  readonly fork?: HostLeaseFork;
  /** Trusted Node composition module; the GUI and CLI use the same kernel. */
  readonly platformModule?: string;
  readonly root: string;
  readonly startupTimeoutMs?: number;
}
export interface DesktopHostLease {
  acquire(): Promise<HostAttachment>;
  close(): Promise<void>;
}

interface OwnedChild {
  exitCode: number | undefined;
  readonly exited: Promise<number>;
  readonly exitListener: (code: number) => void;
  readonly handle: HostLeaseUtilityProcess;
  ready: boolean;
}
function ownChild(handle: HostLeaseUtilityProcess): OwnedChild {
  const completion = Promise.withResolvers<number>();
  const child: OwnedChild = {
    exitCode: undefined,
    exited: completion.promise,
    exitListener: (code) => {
      child.exitCode = code;
      completion.resolve(code);
    },
    handle,
    ready: false,
  };
  handle.once('exit', child.exitListener);
  return child;
}
function startupFailure(root: string, message: StartupMessage): Error {
  if (message.event !== 'failed') {
    return new Error('Unexpected host startup result');
  }
  const lease = RootLock.inspect(root)?.owner;
  if (message.kind === 'root-locked' && lease && !lease.released) {
    return new RootLockedError(lease);
  }
  if (message.kind === 'foreign-lock' && lease) {
    return new ForeignLockError(lease);
  }
  return new Error(message.message);
}
async function awaitReady(child: OwnedChild, root: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.handle.off('message', message);
      signal.removeEventListener('abort', aborted);
    };
    const failed = (cause: unknown): void => {
      cleanup();
      reject(cause);
    };
    const aborted = (): void => failed(signal.reason);
    const message = (input: unknown): void => {
      try {
        const decoded = decodeStartupMessage(input);
        if (decoded.event === 'failed') {
          failed(startupFailure(root, decoded));
          return;
        }
        cleanup();
        resolve();
      } catch (cause) {
        failed(cause);
      }
    };
    child.handle.on('message', message);
    signal.addEventListener('abort', aborted, { once: true });
    void child.exited.then((code) =>
      failed(new Error(`Host utility exited before ready (${code})`))
    );
  });
}
async function closeChild(child: OwnedChild, timeoutMs: number): Promise<void> {
  if (child.exitCode === undefined) {
    child.handle.postMessage({ method: 'close' });
  }
  const code = await runWithTimeout(() => child.exited, {
    onTimeout: () =>
      new Error(`Owned host utility pid ${child.handle.pid} did not exit after close`),
    timeoutMs,
  });
  child.handle.off('exit', child.exitListener);
  if (child.ready && code !== 0) {
    throw new Error(`Owned host utility exited with code ${code}`);
  }
}
function addFinalizer(scope: Scope.Closeable, release: () => Promise<void>): Promise<void> {
  return runAtPromiseBoundary(Scope.addFinalizer(scope, Effect.promise(release)));
}

/** One desktop acquisition lifetime; reset creates a new owner after close succeeds. */
export function createDesktopHostLease(options: DesktopHostLeaseOptions): DesktopHostLease {
  const closeTimeoutMs = options.closeTimeoutMs ?? 1500;
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new RangeError('Host utility close deadline must be positive and finite');
  }
  const scope = Scope.makeUnsafe();
  const abort = new AbortController();
  let acquiring: Promise<HostAttachment> | undefined;
  let closing: Promise<void> | undefined;
  let retired = false;
  let releasing: Promise<void> | undefined;
  const closeScope = (): Promise<void> => {
    releasing ??= runAtPromiseBoundary(Scope.close(scope, Exit.void));
    return releasing;
  };
  const acquire = async (): Promise<HostAttachment> => {
    try {
      const attachment = await launchHost(options.root, {
        ...(options.platformModule === undefined ? {} : { attach: attachAgentHost }),
        lifetime: 'app',
        spawn: async (start: HostStartOptions, signal: AbortSignal) => {
          const combined = AbortSignal.any([signal, abort.signal]);
          combined.throwIfAborted();
          const entrypoint =
            options.entryPath ??
            resolveBundledSiblingPath(
              'Host lease entry',
              options.platformModule === undefined ? 'host-lease-entry.js' : 'agent-host-entry.js'
            );
          const fork: HostLeaseFork =
            options.fork ??
            ((path, args) =>
              utilityProcess.fork(path, [...args], { serviceName: 'Brainstrike Host Lease' }));
          const child = ownChild(
            fork(entrypoint, [
              JSON.stringify(start),
              ...(options.platformModule === undefined ? [] : [options.platformModule]),
            ])
          );
          const ready = awaitReady(child, start.root, combined);
          ready.catch(() => undefined);
          await addFinalizer(scope, () => closeChild(child, closeTimeoutMs));
          await ready;
          child.ready = true;
        },
        ...(options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: options.startupTimeoutMs }),
      });
      await addFinalizer(scope, () => attachment.close());
      if (retired) {
        throw abort.signal.reason;
      }
      return attachment;
    } catch (cause) {
      retired = true;
      try {
        await closeScope();
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], 'Host acquisition and cleanup failed', {
          cause,
        });
      }
      throw cause;
    }
  };
  return {
    acquire: () => {
      if (retired) {
        return Promise.reject(new Error('Desktop host lease owner is closing'));
      }
      acquiring ??= acquire();
      return acquiring;
    },
    close: () => {
      retired = true;
      abort.abort(new Error('Desktop host lease owner is closing'));
      closing ??= (async () => {
        // The acquire path owns failure rollback; close still joins every finalizer.
        await acquiring?.catch(() => undefined);
        await closeScope();
      })();
      return closing;
    },
  };
}
