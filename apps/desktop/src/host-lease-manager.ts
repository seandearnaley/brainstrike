import {
  AGENT_HOST_PROTOCOL_VERSION,
  type HostPlatformLaunchOptions,
} from '@brainstrike/agent-host';
import { attachAgentHost } from '@brainstrike/agent-host/client';
import { runAtPromiseBoundary, runWithTimeout } from '@brainstrike/effect-kit';
import {
  attachHost,
  decodeStartupMessage,
  type HostAttachment,
  type HostStartOptions,
  launchHost,
  type StartupMessage,
} from '@brainstrike/host-lease';
import { ForeignLockError, RootLock, RootLockedError } from '@brainstrike/state-store';
import { Effect, Exit, Scope } from 'effect';
import { type MessagePortMain, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import type { HostLeaseControl } from './host-lease-control';

export interface HostLeaseUtilityProcess {
  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  readonly pid: number | undefined;
  postMessage(
    message: HostLeaseControl | { event: 'platform-capabilities' } | { event: 'client-port' },
    transfer?: readonly MessagePortMain[]
  ): void;
}
export type HostLeaseFork = (
  entrypoint: string,
  args: readonly string[]
) => HostLeaseUtilityProcess;
export interface DesktopHostLeaseOptions {
  readonly closeTimeoutMs?: number;
  readonly entryPath?: string;
  readonly fork?: HostLeaseFork;
  /** A ready child this lease spawned; only it can receive private client ports. */
  readonly onChildReady?: (child: DesktopHostChild) => void;
  /** Created only when this desktop actually owns a new Root child. */
  readonly platform?: () => { readonly port: MessagePortMain; close(): Promise<void> };
  /** Trusted Node composition module; the GUI and CLI use the same kernel. */
  readonly platformModule?: string;
  /** Trusted launch selection for that module, such as the profile's credential store. */
  readonly platformOptions?: () => Promise<HostPlatformLaunchOptions>;
  readonly root: string;
  readonly startupTimeoutMs?: number;
}
export interface DesktopHostChild {
  readonly exited: Promise<number>;
  postClientPort(port: MessagePortMain): void;
}
/** The app-owned agent host composition: its platform port, module and launch selection. */
export type DesktopAgentHostPlatform = Pick<
  DesktopHostLeaseOptions,
  'onChildReady' | 'platform' | 'platformModule' | 'platformOptions'
>;
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
/** Joins the real exit: the platform finalizer behind it must not close the port during cleanup. */
async function closeChild(child: OwnedChild): Promise<void> {
  if (child.exitCode === undefined) {
    child.handle.postMessage({ method: 'close' });
  }
  const code = await child.exited;
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
  let retired = false;
  let releasing: Promise<void> | undefined;
  let ownedPid: number | undefined;
  // One release join; each caller bounds its own wait, so a host that exits after
  // a deadline still completes this join instead of leaving a stale failure.
  const closeScope = (): Promise<void> => {
    if (!releasing) {
      releasing = runAtPromiseBoundary(Scope.close(scope, Exit.void));
      releasing.catch(() => undefined);
    }
    const joined = releasing;
    return runWithTimeout(() => joined, {
      onTimeout: () => new Error(`Owned host utility pid ${ownedPid} did not exit after close`),
      timeoutMs: closeTimeoutMs,
    });
  };
  const acquire = async (): Promise<HostAttachment> => {
    try {
      const attachment = await launchHost(options.root, {
        attach: (record, timeoutMs) =>
          record.protocolVersion === AGENT_HOST_PROTOCOL_VERSION
            ? attachAgentHost(record, timeoutMs)
            : attachHost(record, timeoutMs),
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
          const platformOptions =
            options.platformModule === undefined ? undefined : await options.platformOptions?.();
          combined.throwIfAborted();
          const platform = options.platform?.();
          if (platform) {
            // Runs after closeChild has joined the host's exit, never during its cleanup.
            await addFinalizer(scope, () => platform.close());
          }
          const child = ownChild(
            fork(entrypoint, [
              JSON.stringify(start),
              ...(options.platformModule === undefined ? [] : [options.platformModule]),
              ...(platformOptions === undefined
                ? []
                : ['--platform-options', JSON.stringify(platformOptions)]),
            ])
          );
          ownedPid = child.handle.pid;
          const ready = awaitReady(child, start.root, combined);
          ready.catch(() => undefined);
          await addFinalizer(scope, () => closeChild(child));
          if (platform) {
            child.handle.postMessage({ event: 'platform-capabilities' }, [platform.port]);
          }
          await ready;
          child.ready = true;
          options.onChildReady?.({
            exited: child.exited,
            postClientPort: (port) => child.handle.postMessage({ event: 'client-port' }, [port]),
          });
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
      // The acquire path owns failure rollback; close still joins every finalizer.
      return (acquiring?.catch(() => undefined) ?? Promise.resolve()).then(closeScope);
    },
  };
}
