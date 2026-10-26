import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import type { HostPlatformLaunchOptions } from '@brainstrike/agent-host';
import { authenticateHostClient, type HostClient } from '@brainstrike/agent-host/client';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_VERSION } from '@brainstrike/agent-host/protocol';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { markDescriptorsCloseOnExec } from '@brainstrike/secure-fs-native';
import { type ClearContentResult, RootLockedError } from '@brainstrike/state-store';
import { Effect, Exit, Scope } from 'effect';
import { mainPlatformConnection, type PlatformMessagePort } from './agent-host-platform/connection';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { HOST_LEASE_CLOSED } from './desktop-shutdown-state';
import {
  decodeHostChildMessage,
  encodeHostChildArgs,
  type HostChildControl,
  type HostChildMessage,
} from './host-child-messages';
import { type HostStdio, openHostStdio } from './host-stdio';

const logger = createLogger('DesktopHostLease');
/**
 * Quit is ask, wait, kill, as VS Code ends its extension host: every write is
 * committed as it happens, so a host still running after this grace loses nothing.
 */
export const HOST_CLOSE_GRACE_MS = 5000;

/** The host as a plain child process with piped stdio, as Node's `spawn` returns it. */
export interface HostChildProcess {
  /** SIGKILL on POSIX; TerminateProcess on Windows. */
  kill(signal: 'SIGKILL'): boolean;
  /** Its OS exit. Unlike `close`, it never waits for a stdio pipe another process may hold. */
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  once(event: 'error', listener: (cause: Error) => void): unknown;
  readonly pid?: number | undefined;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly stdout: Readable;
}
type HostLeaseSpawn = (
  entrypoint: string,
  args: readonly string[],
  /** Main's environment. */
  env: NodeJS.ProcessEnv
) => HostChildProcess;
/**
 * Electron's own Node runs the headless host entry, so its native add-ons match; under
 * plain Node the same entry runs unchanged. Its stderr is copied to Main's. Chromium opens
 * descriptors without close-on-exec, so Main marks them first: the host and every command it
 * starts inherit only the stdio given here, and none can hold Main's files or sockets.
 */
export function spawnHostProcess(
  entrypoint: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): HostChildProcess {
  markDescriptorsCloseOnExec();
  const ownGroup = process.platform !== 'win32';
  const child = spawn(process.execPath, [entrypoint, ...args], {
    detached: ownGroup,
    // biome-ignore lint/style/useNamingConvention: Electron's documented Node-mode switch.
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const { pid } = child;
  if (ownGroup && pid !== undefined) {
    // POSIX: the host leads its own group, so what it starts without a group of its own, such
    // as MCP and LSP servers, ends with it. On Windows its kill-on-close Job does this.
    child.once('exit', () => killCommandGroup(pid));
  }
  child.stderr.pipe(process.stderr, { end: false });
  return child;
}
export interface DesktopHostLeaseOptions {
  /** How long a close waits for the host to exit before killing it. */
  readonly closeGraceMs?: number;
  readonly entryPath?: string;
  /** The ready child; Main opens each visible client's channel on it. */
  readonly onChildReady?: (child: DesktopHostChild) => void;
  /** The host is spawned and its platform channel is open. */
  readonly onChildStarted?: () => void;
  /**
   * BST-2004: the ready child's output ended while this owner was not closing it: a crash, a
   * kill, an exit of its own, or a stop for a relaunch the user asked for (`requested`). It is
   * called when the host's protocol stream ends, which is when its platform channel closes,
   * not at its OS exit, which can come later; `exited` settles with that exit's code. Never
   * called for a close of the lease itself.
   */
  readonly onLost?: (loss: {
    readonly exited: Promise<number>;
    readonly requested: boolean;
  }) => void;
  /** Main's platform, served on the host's platform channel. */
  readonly platform?: (port: PlatformMessagePort) => {
    close(): Promise<void>;
  };
  /** Trusted Node composition module; the GUI and CLI use the same kernel. */
  readonly platformModule?: string;
  /** Trusted launch selection for that module, such as the profile's credential store. */
  readonly platformOptions?: () => Promise<HostPlatformLaunchOptions>;
  readonly root: string;
  readonly spawn?: HostLeaseSpawn;
}
export interface DesktopHostChild {
  readonly exited: Promise<number>;
  /** A new client channel, as the visible-UI origin. */
  openClientPort(): PlatformMessagePort;
  /** Ends this child for a user's restart; its exit takes the lost-host path, as requested. */
  stopForRelaunch(): Promise<number>;
}
export interface DesktopHostLease {
  acquire(): Promise<HostClient>;
  clearAndRetireContent(): Promise<ClearContentResult>;
  close(reason?: unknown): Promise<void>;
}

interface OwnedChild {
  /** Main is ending it (close, relaunch or clear): its exit is not a loss. */
  closing: boolean;
  exitCode: number | undefined;
  readonly exited: Promise<number>;
  /** Listeners for the child's protocol failures and reports. */
  readonly failures: Set<(cause: unknown) => void>;
  readonly handle: HostChildProcess;
  readonly messages: Set<(message: HostChildMessage) => void>;
  ready: boolean;
  relaunchRequested: boolean;
  readonly stdio: HostStdio;
  /** This child's one ask-wait-kill, shared by every close of it. */
  stopping?: Promise<number>;
}
function ownChild(handle: HostChildProcess, lost: () => void): OwnedChild {
  const completion = Promise.withResolvers<number>();
  const messages = new Set<(message: HostChildMessage) => void>();
  const failures = new Set<(cause: unknown) => void>();
  // The POSIX command groups the host reported and has not seen end (ADR-0031).
  const commandGroups = new Set<number>();
  const broken = (cause: unknown): void => {
    for (const failed of failures) {
      failed(cause);
    }
    logger.error('The agent host wrote something that is not its protocol; killing it', {
      cause,
    });
    handle.kill('SIGKILL');
  };
  const stdio = openHostStdio(handle.stdout, handle.stdin, {
    invalid: broken,
    message: (input) => {
      let decoded: HostChildMessage;
      try {
        decoded = decodeHostChildMessage(input);
      } catch (cause) {
        broken(cause);
        return;
      }
      if (decoded.event === 'command-group') {
        if (decoded.state === 'started') {
          commandGroups.add(decoded.pgid);
        } else {
          commandGroups.delete(decoded.pgid);
        }
        return;
      }
      for (const received of messages) {
        received(decoded);
      }
    },
  });
  const child: OwnedChild = {
    closing: false,
    exitCode: undefined,
    exited: completion.promise,
    failures,
    handle,
    messages,
    ready: false,
    relaunchRequested: false,
    stdio,
  };
  const exited = (code: number): void => {
    if (child.exitCode !== undefined) {
      return;
    }
    child.exitCode = code;
    // However the host ended, no command group it started outlives it: a kill of the host
    // never reaches another group, and every report it wrote has been read by now.
    for (const pgid of commandGroups) {
      killCommandGroup(pgid);
    }
    commandGroups.clear();
    completion.resolve(code);
  };
  // The host is lost once its protocol stream ends: it reports nothing and serves no channel
  // after that, and Main's platform channel closes with it. Its OS exit can come later (on
  // Windows it did), so Main never waits for that exit to learn the host is gone.
  void stdio.ended.then(() => {
    if (!child.closing || child.relaunchRequested) {
      lost();
    }
  });
  // The host is gone at its OS exit once its stdout has ended, so every report it wrote has
  // been read. Only the host holds its stdout. Its stderr is diagnostics, and a process it
  // started may still hold that pipe (on Windows too), so nothing waits for stderr to end.
  handle.once('exit', (code, signal) => {
    const exitCode = code ?? 128 + (signal ? constants.signals[signal] : 0);
    void stdio.ended.then(() => exited(exitCode));
  });
  // A host that could not be spawned never exits.
  handle.once('error', (cause) => {
    if (handle.pid === undefined) {
      logger.error('Could not start the agent host', { cause });
      exited(1);
    }
  });
  return child;
}
/** The child's first message: `ready`, or the failure it reported, or its exit before either. */
async function awaitReady(child: OwnedChild, root: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.messages.delete(message);
      child.failures.delete(failed);
      signal.removeEventListener('abort', aborted);
    };
    const failed = (cause: unknown): void => {
      cleanup();
      reject(cause);
    };
    const aborted = (): void => failed(signal.reason);
    const message = (decoded: HostChildMessage): void => {
      if (decoded.event === 'ready') {
        cleanup();
        resolve();
      } else if (decoded.event === 'failed') {
        failed(
          decoded.kind === 'root-locked' ? new RootLockedError(root) : new Error(decoded.message)
        );
      }
    };
    child.messages.add(message);
    child.failures.add(failed);
    signal.addEventListener('abort', aborted, { once: true });
    void child.exited.then((code) => failed(new Error(`Agent host exited before ready (${code})`)));
  });
}
function killCommandGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (cause) {
    // A group whose every member has exited is gone; that is the outcome asked for.
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) {
      logger.error('Could not end a command group the agent host left running', { cause, pgid });
    }
  }
}
/** End the child's stdin, kill it if it is still running after `graceMs`, and join its exit. */
function stopChild(child: OwnedChild, graceMs: number): Promise<number> {
  child.closing = true;
  child.stopping ??= (async () => {
    if (child.exitCode !== undefined) {
      return child.exitCode;
    }
    // Its stdin's end asks the host to close; it needs nothing from Main to do so.
    child.stdio.end();
    const grace = setTimeout(() => {
      logger.warn('The agent host did not exit after its stdin ended; killing it', {
        graceMs,
        pid: child.handle.pid,
      });
      child.handle.kill('SIGKILL');
    }, graceMs);
    try {
      return await child.exited;
    } finally {
      clearTimeout(grace);
    }
  })();
  return child.stopping;
}
function addFinalizer(scope: Scope.Closeable, release: () => Promise<void>): Promise<void> {
  return runAtPromiseBoundary(Scope.addFinalizer(scope, Effect.promise(release)));
}
/** Main's own client of the host: the desktop origin, on a channel only Main holds. */
async function connectMainClient(child: OwnedChild, signal: AbortSignal): Promise<HostClient> {
  signal.throwIfAborted();
  const port = child.stdio.open('main');
  const closed = new Promise<void>((resolve) => port.on('close', () => resolve()));
  // A close during the handshake closes its channel, so a host that never answers cannot hold quit.
  const aborted = (): void => port.close();
  signal.addEventListener('abort', aborted, { once: true });
  void closed.then(() => signal.removeEventListener('abort', aborted));
  return await authenticateHostClient(
    mainPlatformConnection(port),
    { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
    async () => {
      port.close();
    },
    closed
  );
}

/** One desktop host child: spawned on first acquire, ended by close. Reset creates a new one. */
export function createDesktopHostLease(options: DesktopHostLeaseOptions): DesktopHostLease {
  const graceMs = options.closeGraceMs ?? HOST_CLOSE_GRACE_MS;
  const scope = Scope.makeUnsafe();
  const abort = new AbortController();
  let acquiring: Promise<HostClient> | undefined;
  let retired = false;
  let releasing: Promise<void> | undefined;
  let ownedChild: OwnedChild | undefined;
  let clearing: Promise<ClearContentResult> | undefined;
  let clients = 0;
  const closeScope = (): Promise<void> => {
    releasing ??= runAtPromiseBoundary(Scope.close(scope, Exit.void));
    return releasing;
  };
  const acquire = async (): Promise<HostClient> => {
    try {
      const entrypoint =
        options.entryPath ?? resolveBundledSiblingPath('Agent host', 'agent-host-entry.js');
      const modulePath =
        options.platformModule ??
        resolveBundledSiblingPath('Agent host platform', 'agent-host-platform-entry.js');
      const spawnHost = options.spawn ?? spawnHostProcess;
      const platformOptions = await options.platformOptions?.();
      abort.signal.throwIfAborted();
      let platform: { close(): Promise<void> } | undefined;
      // Runs after the host has exited.
      await addFinalizer(scope, async () => {
        await platform?.close();
      });
      const child = ownChild(
        spawnHost(
          entrypoint,
          encodeHostChildArgs({
            modulePath,
            root: options.root,
            ...(platformOptions === undefined ? {} : { platformOptions }),
          }),
          process.env
        ),
        () => {
          // A child lost before ready fails its acquisition instead.
          if (child.ready) {
            options.onLost?.({ exited: child.exited, requested: child.relaunchRequested });
          }
        }
      );
      ownedChild = child;
      // Listening from the spawn on: the child's one report is never missed.
      const ready = awaitReady(child, options.root, abort.signal);
      ready.catch(() => undefined);
      // Runs first: the host exits before its platform is released.
      await addFinalizer(scope, async () => {
        await stopChild(child, graceMs);
      });
      if (options.platform) {
        // Before the host's startup asks for it; the channel holds requests until Main serves it.
        platform = options.platform(child.stdio.open('platform'));
      }
      options.onChildStarted?.();
      await ready;
      child.ready = true;
      const client = await connectMainClient(child, abort.signal);
      await addFinalizer(scope, () => client.close());
      options.onChildReady?.({
        exited: child.exited,
        openClientPort: () => {
          clients += 1;
          return child.stdio.open(`client-${clients}`);
        },
        stopForRelaunch: () => {
          child.relaunchRequested = true;
          return stopChild(child, graceMs);
        },
      });
      if (retired) {
        throw abort.signal.reason;
      }
      return client;
    } catch (failure) {
      retired = true;
      // A startup its own close cancelled settles with that close's typed reason.
      const cause: unknown = abort.signal.aborted ? abort.signal.reason : failure;
      // ADR-0031: a refused start is its acquisition's answer the moment the host reports it.
      // The release goes on; this lease's close joins it and reports a failed cleanup.
      closeScope().catch(() => undefined);
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
      if (retired || !child?.ready || child.exitCode !== undefined) {
        return Promise.reject(new Error('Content clear requires this lease’s ready agent host'));
      }
      retired = true;
      // ADR-0015: a content clear is never killed; its deletion completes, then the host exits.
      child.closing = true;
      const receipt = new Promise<ClearContentResult>((resolve, reject) => {
        const received = (decoded: HostChildMessage): void => {
          if (decoded.event === 'content-cleared') {
            const { event: _event, ...result } = decoded;
            resolve(result);
          }
        };
        child.messages.add(received);
        child.failures.add(reject);
        void child.exited.then((code) => {
          child.messages.delete(received);
          child.failures.delete(reject);
          reject(new Error(`Agent host exited (${code}) without a content-clear receipt`));
        });
      });
      receipt.catch(() => undefined);
      child.stopping = child.exited;
      const control: HostChildControl = { method: 'clear-content' };
      child.stdio.message(control).catch((cause: unknown) => {
        logger.error('Could not ask the agent host to clear its content', { cause });
      });
      clearing = (async () => {
        await child.exited;
        await closeScope();
        return await receipt;
      })();
      return clearing;
    },
    // A startup this close cancels settles with the typed closing outcome (BST-2118).
    close: (reason = new BoundaryFailureError(HOST_LEASE_CLOSED)) => {
      retired = true;
      abort.abort(reason);
      return (acquiring?.catch(() => undefined) ?? Promise.resolve()).then(closeScope);
    },
  };
}
