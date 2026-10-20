import type { HostPlatformLaunchOptions } from '@brainstrike/agent-host';
import { isPeerReset } from '@brainstrike/agent-host/boundary-wire';
import { attachAgentHost, attachStartedAgentHost } from '@brainstrike/agent-host/client';
import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import {
  attachHost,
  attachStartedHost,
  decodeStartupMessage,
  type HostAttachment,
  type HostRecord,
  type HostStartOptions,
  startupFailure as hostStartupFailure,
  launchHost,
  type StartupMessage,
} from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import { type ClearContentResult, processStartTime } from '@brainstrike/state-store';
import { Effect, Exit, Scope } from 'effect';
import { MessageChannelMain, type MessagePortMain, utilityProcess } from 'electron';
import {
  createHostNativeChildren,
  type HostNativeChildren,
} from './agent-host-platform/host-native-children';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { HOST_LEASE_CLOSED } from './desktop-shutdown-state';
import { decodeHostContentCleared, type HostLeaseControl } from './host-lease-control';
import type { LifecycleDelaySeam } from './lifecycle-delay-seam';

const logger = createLogger('DesktopHostLease');
/**
 * When Main logs that the host it forked has not reported ready yet. Neither an
 * R5(a) nor an R5(b) bound: a diagnostic that never acts (lifecycle R3, owner
 * decision 7.1(i)). It names the stage Main is waiting on; the start still ends
 * only with the host's ready or failed report, its exit, or this lease closing.
 */
const HOST_STARTUP_STALL_WARN_MS = 10_000;

export interface HostLeaseUtilityProcess {
  /** Electron: SIGTERM, then SIGKILL if it is still running 2 s later (Windows: terminate). */
  kill(): boolean;
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
  args: readonly string[],
  /** Main's environment plus the entries this lease forwards explicitly (the E2E delay seam). */
  env: NodeJS.ProcessEnv
) => HostLeaseUtilityProcess;
/**
 * R5(b) (ADR-0026, owner decision 7.2(ii)): how long Main waits for its own host to exit after
 * asking it to close before it escalates to `kill()`. The exit is joined either way: the
 * escalation is a warn, never a failed close and never an abandoned process.
 */
export const HOST_COOPERATIVE_CLOSE_MS = 30_000;

export interface DesktopHostLeaseOptions {
  /** The cooperative rung of the close ladder; defaults to `HOST_COOPERATIVE_CLOSE_MS`. */
  readonly cooperativeCloseMs?: number;
  readonly entryPath?: string;
  readonly fork?: HostLeaseFork;
  /**
   * Main's E2E lifecycle delay seam (`installLifecycleDelaySeam`): Main-side points this owner
   * applies, and the child points it forwards to the host it forks. Absent, nothing is delayed.
   */
  readonly lifecycleDelays?: LifecycleDelaySeam;
  /** The owned host's lifetime channel (ADR-0017); Main keeps `port1`. Defaults to a new channel. */
  readonly lifetimeChannel?: () => {
    readonly port1: MessagePortMain;
    readonly port2: MessagePortMain;
  };
  /** A ready child this lease spawned; only it can receive private client ports. */
  readonly onChildReady?: (child: DesktopHostChild) => void;
  /** The owned utility is forked and its lifetime/platform ports are transferred. */
  readonly onChildStarted?: () => void;
  /**
   * BST-2004: the ready child exited without this owner asking (a crash, a kill
   * or a clean exit of its own). Never called for a close this owner requested.
   */
  readonly onLost?: (code: number) => void;
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
export interface DesktopHostLease {
  acquire(): Promise<HostAttachment>;
  clearAndRetireContent(): Promise<ClearContentResult>;
  close(reason?: unknown): Promise<void>;
}

interface OwnedChild {
  clearFailure?: unknown;
  clearReceipt?: ClearContentResult;
  clearRequested?: boolean;
  closing: boolean;
  exitCode: number | undefined;
  readonly exited: Promise<number>;
  readonly exitListener: (code: number) => void;
  readonly handle: HostLeaseUtilityProcess;
  /** This owner escalated its close to `kill()`: its exit code is the kill's, not a failure. */
  killed: boolean;
  /** It exited before this owner asked it to close. */
  lost: boolean;
  ready: boolean;
}
/** `lost` runs when the child exits before this owner asked it to close. */
function ownChild(handle: HostLeaseUtilityProcess, lost: (code: number) => void): OwnedChild {
  const completion = Promise.withResolvers<number>();
  const child: OwnedChild = {
    closing: false,
    exitCode: undefined,
    exited: completion.promise,
    exitListener: (code) => {
      child.exitCode = code;
      completion.resolve(code);
      if (!child.closing) {
        child.lost = true;
        lost(code);
      }
    },
    handle,
    killed: false,
    lost: false,
    ready: false,
  };
  handle.once('exit', child.exitListener);
  return child;
}
function startupFailure(root: string, message: StartupMessage): Error {
  if (message.event !== 'failed') {
    return new Error('Unexpected host startup result');
  }
  // One mapping for every starter (BST-2142): a late root-locked report is
  // the launcher's cue to acquire again, not an owner to name.
  return hostStartupFailure(root, message);
}
/** The record the child's ready report carried; a `failed` report, its exit or `signal` rejects. */
async function awaitReady(
  child: OwnedChild,
  root: string,
  signal: AbortSignal
): Promise<HostRecord> {
  signal.throwIfAborted();
  return await new Promise<HostRecord>((resolve, reject) => {
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
        resolve(decoded.record);
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
/**
 * BST-2176, lifecycle R3: the ready report is trusted only for the utility
 * this owner forked. Its record must name that utility's PID and OS start
 * time, read before this owner has observed its exit (a zombie has no start time).
 */
function readyRecord(child: OwnedChild, record: HostRecord): HostRecord {
  const pid = child.handle.pid;
  const start = child.exitCode === undefined && pid !== undefined ? processStartTime(pid) : null;
  if (pid === undefined || start === null) {
    throw new Error(`Host utility pid ${pid} exited as it reported ready`);
  }
  if (record.pid !== pid || record.start !== start) {
    throw new Error(`Host utility pid ${pid} reported ready with another process's record`);
  }
  return record;
}
interface CloseLadder {
  readonly cooperativeMs: number;
  readonly delays: LifecycleDelaySeam | undefined;
}
/**
 * The cooperative rung: resolves once `exited` settles, or after `cooperativeMs`, when it
 * escalates to `kill()`. Its timer is cleared either way; the caller still joins the exit.
 */
async function escalateUnlessExited(
  child: OwnedChild,
  exited: Promise<number>,
  cooperativeMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rung = new Promise<'escalate'>((resolve) => {
    timer = setTimeout(() => resolve('escalate'), cooperativeMs);
  });
  try {
    if ((await Promise.race([exited, rung])) !== 'escalate') {
      return;
    }
  } finally {
    clearTimeout(timer);
  }
  child.killed = true;
  logger.warn('The owned agent host did not exit after close; killing it', {
    cooperativeMs,
    pid: child.handle.pid,
  });
  child.handle.kill();
}
/**
 * Joins the real exit: the platform finalizer behind it must not close the port during cleanup.
 * A close this owner asks for is a ladder it owns (ADR-0026 R5(b)): ask, join the exit, and after
 * `cooperativeMs` without one `kill()` and join the exit. A content clear is never killed: its
 * deletion completes under the lease (ADR-0015), so its own exit is joined without a rung.
 */
async function closeChild(child: OwnedChild, ladder: CloseLadder): Promise<void> {
  child.closing = true;
  // E2E seam: Main observes the exit this much later, still inside the ladder.
  const exited = child.exited.then(async (code) => {
    await ladder.delays?.delay('child-exit');
    return code;
  });
  if (child.exitCode === undefined && !child.clearRequested) {
    child.handle.postMessage({ method: 'close' });
    await escalateUnlessExited(child, exited, ladder.cooperativeMs);
  }
  const code = await exited;
  child.handle.off('exit', child.exitListener);
  if (child.clearRequested && !child.clearReceipt) {
    throw child.clearFailure ?? new Error('Owned host exited without a content-clear receipt');
  }
  // A lost host's exit was reported when it happened, and a kill this owner escalated to was
  // logged then: neither is a failed close.
  if (child.ready && code !== 0 && !(child.lost || child.killed)) {
    throw new Error(`Owned host utility exited with code ${code}`);
  }
}
/** The peer closed with Main's bytes unread or unsent: the reset a closing host's socket reports. */
function isPeerResetOnly(cause: unknown): boolean {
  if (cause instanceof AggregateError) {
    return cause.errors.length > 0 && cause.errors.every(isPeerResetOnly);
  }
  return isPeerReset(cause);
}
/**
 * Only the host can reset Main's end of this connection, and this release
 * closes it before closeChild asks the host to close. A reset here is the
 * host ending the connection with Main's requests in flight: it was lost
 * (BST-2143), or it is closing on its own, as when a signal to Main's process
 * group reaches it too (BST-2192). Either way closeChild still joins its exit
 * and reports a failed one. After this owner asked first (a content clear), or
 * on a host it did not start, a reset stays a close failure.
 */
async function closeAttachment(
  attachment: HostAttachment,
  child: OwnedChild | undefined
): Promise<void> {
  try {
    await attachment.close();
  } catch (cause) {
    if (!(child && !child.closing && isPeerResetOnly(cause))) {
      throw cause;
    }
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
  const ladder: CloseLadder = {
    cooperativeMs: options.cooperativeCloseMs ?? HOST_COOPERATIVE_CLOSE_MS,
    delays: options.lifecycleDelays,
  };
  if (!(Number.isFinite(ladder.cooperativeMs) && ladder.cooperativeMs > 0)) {
    throw new RangeError('Host utility cooperative close must be positive and finite');
  }
  const scope = Scope.makeUnsafe();
  const abort = new AbortController();
  let acquiring: Promise<HostAttachment> | undefined;
  let retired = false;
  let releasing: Promise<void> | undefined;
  let ownedChild: OwnedChild | undefined;
  let clearing: Promise<ClearContentResult> | undefined;
  /** A lost host's native processes, settled once their SIGTERM grace ran (ADR-0017). */
  let lostTail: Promise<void> | undefined;
  // One release join for every caller. It is finite because its child ladder is
  // (closeChild), never because a caller stops waiting: no caller-side deadline.
  const closeScope = (): Promise<void> => {
    if (!releasing) {
      releasing = runAtPromiseBoundary(Scope.close(scope, Exit.void));
      releasing.catch(() => undefined);
    }
    return releasing;
  };
  const acquire = async (): Promise<HostAttachment> => {
    try {
      const attachment = await launchHost(options.root, {
        attach: (record, timeoutMs) =>
          record.protocolVersion === AGENT_HOST_PROTOCOL_VERSION
            ? attachAgentHost(record, timeoutMs)
            : attachHost(record, timeoutMs),
        // Lifecycle R3: the host this lease forked is attached from its ready
        // record over its socket, with no deadline. Only its exit, its socket
        // closing or this lease closing ends the attach.
        attachStarted: (record) => {
          const child = ownedChild;
          if (!child) {
            throw new Error('The started host has no utility this lease forked');
          }
          const exited = new AbortController();
          void child.exited.then((code) =>
            exited.abort(new Error(`Host utility exited (${code}) before Main attached`))
          );
          const signal = AbortSignal.any([abort.signal, exited.signal]);
          return record.protocolVersion === AGENT_HOST_PROTOCOL_VERSION
            ? attachStartedAgentHost(record, signal)
            : attachStartedHost(record, signal);
        },
        beforeRecordRead: async () => {
          await options.lifecycleDelays?.delay('record-read');
        },
        lifetime: 'app',
        signal: abort.signal,
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
            ((path, args, env) =>
              utilityProcess.fork(path, [...args], { env, serviceName: 'Brainstrike Host Lease' }));
          const platformOptions =
            options.platformModule === undefined ? undefined : await options.platformOptions?.();
          combined.throwIfAborted();
          const { nativeChildren, platform } = await ownPlatform(scope, options);
          const child = ownChild(
            fork(
              entrypoint,
              [
                JSON.stringify(start),
                ...(options.platformModule === undefined ? [] : [options.platformModule]),
                ...(platformOptions === undefined
                  ? []
                  : ['--platform-options', JSON.stringify(platformOptions)]),
              ],
              { ...process.env, ...options.lifecycleDelays?.childEnv(['host-ready']) }
            ),
            (code) => {
              // A lost host leaves its native processes to Main (ADR-0017).
              lostTail = nativeChildren?.retire();
              // A child lost before ready fails its acquisition instead.
              if (child.ready) {
                options.onLost?.(code);
              }
            }
          );
          ownedChild = child;
          let stage: 'forked' | 'spawned' = 'forked';
          // Electron's utilityProcess has no pid until its spawn event.
          child.handle.once('spawn', () => {
            stage = 'spawned';
          });
          const ready = awaitReady(child, start.root, combined);
          ready.catch(() => undefined);
          const stall = setTimeout(() => {
            logger.warn('The agent host has not reported ready; still waiting for it', {
              elapsedMs: HOST_STARTUP_STALL_WARN_MS,
              pid: child.handle.pid,
              stage,
            });
          }, HOST_STARTUP_STALL_WARN_MS);
          stall.unref();
          const settled = (): void => clearTimeout(stall);
          ready.then(settled, settled);
          await ownLifetime(scope, options, child);
          await addFinalizer(scope, () => closeChild(child, ladder));
          if (platform) {
            child.handle.postMessage({ event: 'platform-capabilities' }, [platform.port]);
          }
          options.onChildStarted?.();
          const record = readyRecord(child, await ready);
          child.ready = true;
          options.onChildReady?.({
            exited: child.exited,
            postClientPort: (port) => child.handle.postMessage({ event: 'client-port' }, [port]),
          });
          // BST-2167: this lease's Scope stays the child's one owner. An
          // attached host needs no hand-off; a launch that gives up closes it.
          return { record, release: async () => undefined, retire: closeScope };
        },
        ...(options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: options.startupTimeoutMs }),
      });
      await addFinalizer(scope, () => closeAttachment(attachment, ownedChild));
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
        return Promise.reject(new BoundaryFailureError(HOST_LEASE_CLOSED));
      }
      acquiring ??= acquire();
      return acquiring;
    },
    clearAndRetireContent: () => {
      if (clearing) {
        return clearing;
      }
      const child = ownedChild;
      if (retired || !child?.ready || child.exitCode !== undefined || !options.platformModule) {
        return Promise.reject(new Error('Content clear requires this lease’s ready agent host'));
      }
      retired = true;
      child.closing = true;
      child.clearRequested = true;
      const received = (input: unknown): void => {
        try {
          const { event: _event, ...receipt } = decodeHostContentCleared(input);
          child.clearReceipt = receipt;
        } catch (cause) {
          child.clearFailure = cause;
        }
      };
      child.handle.on('message', received);
      void child.exited.then(() => child.handle.off('message', received));
      try {
        child.handle.postMessage({ method: 'clear-content' });
      } catch (cause) {
        child.handle.off('message', received);
        child.clearRequested = false;
        return Promise.reject(cause);
      }
      clearing = closeScope().then(() => {
        if (!child.clearReceipt) {
          throw new Error('Content clear receipt unavailable');
        }
        return child.clearReceipt;
      });
      return clearing;
    },
    // A startup this close cancels settles with the typed closing outcome (BST-2118).
    close: (reason = new BoundaryFailureError(HOST_LEASE_CLOSED)) => {
      retired = true;
      abort.abort(reason);
      // The acquire path owns failure rollback; close still joins every finalizer.
      // A lost host's processes keep their SIGTERM grace, even when the next
      // client's admission is what closes this owner (BST-2004).
      return (acquiring?.catch(() => undefined) ?? Promise.resolve())
        .then(() => lostTail)
        .then(closeScope);
    },
  };
}
