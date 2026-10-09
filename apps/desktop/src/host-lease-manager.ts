import type { HostPlatformLaunchOptions } from '@brainstrike/agent-host';
import { attachAgentHost } from '@brainstrike/agent-host/client';
import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
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
import { MessageChannelMain, type MessagePortMain, utilityProcess } from 'electron';
import {
  createHostNativeChildren,
  type HostNativeChildren,
} from './agent-host-platform/host-native-children';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import type { HostLeaseControl } from './host-lease-control';

export interface HostLeaseUtilityProcess {
  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  /** Electron reports it only once the utility has spawned. */
  readonly pid: number | undefined;
  postMessage(
    message:
      | HostLeaseControl
      | { event: 'platform-capabilities' }
      | { event: 'client-port' }
      | { event: 'lifetime' },
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
  /** The owned host's lifetime channel (ADR-0017); Main keeps `port1`. Defaults to a new channel. */
  readonly lifetimeChannel?: () => {
    readonly port1: MessagePortMain;
    readonly port2: MessagePortMain;
  };
  /** A ready child this lease spawned; only it can receive private client ports. */
  readonly onChildReady?: (child: DesktopHostChild) => void;
  /**
   * Created only when this desktop actually owns a new Root child. Its platform connection
   * feeds `nativeChildren`, through which Main supervises that host's native processes.
   */
  readonly platform?: (nativeChildren: HostNativeChildren) => {
    readonly port: MessagePortMain;
    close(): Promise<void>;
  };
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
  closing: boolean;
  exitCode: number | undefined;
  readonly exited: Promise<number>;
  readonly exitListener: (code: number) => void;
  readonly handle: HostLeaseUtilityProcess;
  ready: boolean;
}
/** `lost` runs when the child exits before this owner asked it to close. */
function ownChild(handle: HostLeaseUtilityProcess, lost: () => void): OwnedChild {
  const completion = Promise.withResolvers<number>();
  const child: OwnedChild = {
    closing: false,
    exitCode: undefined,
    exited: completion.promise,
    exitListener: (code) => {
      child.exitCode = code;
      completion.resolve(code);
      if (!child.closing) {
        lost();
      }
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
  child.closing = true;
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
/**
 * ADR-0017: a host forked by the app dies with the app. The host gets one end of a lifetime channel
 * and closes when it closes; Main closes its end only after closeChild has joined the host's exit
 * (this finalizer is added first, so it runs after that join). While the host runs, its end closes
 * only when Main lets it go or Main's process dies.
 */
async function ownLifetime(
  scope: Scope.Closeable,
  options: DesktopHostLeaseOptions,
  child: OwnedChild
): Promise<void> {
  const channel = (options.lifetimeChannel ?? (() => new MessageChannelMain()))();
  await addFinalizer(scope, async () => channel.port1.close());
  child.handle.postMessage({ event: 'lifetime' }, [channel.port2]);
}
/** The platform an owned host borrows, and Main's supervisor of its native processes (ADR-0017). */
async function ownPlatform(
  scope: Scope.Closeable,
  options: DesktopHostLeaseOptions
): Promise<{
  readonly nativeChildren?: HostNativeChildren;
  readonly platform?: ReturnType<NonNullable<DesktopHostLeaseOptions['platform']>>;
}> {
  if (!options.platform) {
    return {};
  }
  const nativeChildren = createHostNativeChildren(options.root);
  // Runs last, after the platform closed: join the host's native processes, then
  // require the Root's flock free.
  await addFinalizer(scope, () => nativeChildren.close());
  const platform = options.platform(nativeChildren);
  // Runs after closeChild has joined the host's exit, never during its cleanup.
  await addFinalizer(scope, () => platform.close());
  return { nativeChildren, platform };
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
          const { nativeChildren, platform } = await ownPlatform(scope, options);
          const child = ownChild(
            fork(entrypoint, [
              JSON.stringify(start),
              ...(options.platformModule === undefined ? [] : [options.platformModule]),
              ...(platformOptions === undefined
                ? []
                : ['--platform-options', JSON.stringify(platformOptions)]),
            ]),
            // A lost host leaves its native processes to Main (ADR-0017).
            () => nativeChildren?.retire()
          );
          // Electron's utilityProcess has no pid until its spawn event.
          child.handle.once('spawn', () => {
            ownedPid = child.handle.pid;
          });
          const ready = awaitReady(child, start.root, combined);
          ready.catch(() => undefined);
          await ownLifetime(scope, options, child);
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
