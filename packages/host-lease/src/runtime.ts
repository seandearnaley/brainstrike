import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { assertNotSyncedRoot, processStartTime, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { destroySocket, receiveFrames, sendFrame } from './frames.js';
import {
  decodeRequest,
  HOST_VERSION,
  type HostRecord,
  type HostRequest,
  PROTOCOL_VERSION,
  tokensEqual,
} from './record.js';
import { publishHostRecord, removeOwnHostRecord, secureDirectory } from './record-file.js';
import { ResourceOwner } from './resource-owner.js';

export type HostLifetime = 'app' | 'cli' | 'persistent';
export type HostStartOptions = typeof StartOptionsSchema.Type;
export interface HostRuntime {
  readonly clientCount: number;
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly record: HostRecord;
  retainRun(): () => void;
}
/** M3 composes the existing lease with its store owner and client protocol. */
export interface HostRuntimeBindings {
  acceptSocket(
    socket: Socket,
    record: HostRecord,
    attached: () => void,
    lifecycle: HostSocketLifecycle
  ): void;
  acquireRoot(
    retainRun: () => () => void
  ): Promise<{ readonly lock: RootLock; close(): Promise<void> }>;
  /** Fence/start retirement now; acquireRoot.close must join that same retirement. */
  beginClose?(): void;
  readonly protocolVersion: number;
}
export interface HostSocketLifecycle {
  readonly closing: boolean;
  /** Keep this socket through its actual RPC response write, after Root joins. */
  stop(replyFinished: Promise<void>): Promise<void>;
}
const StartOptionsSchema = Schema.Struct({
  lifetime: Schema.Literals(['app', 'cli', 'persistent']),
  parent: Schema.optional(
    Schema.Struct({
      pid: Schema.Int.check(Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })),
      start: Schema.String.check(Schema.isPattern(/^.{1,256}$/)),
    })
  ),
  root: Schema.String.check(Schema.isPattern(/^[^\r\n\0]{1,4096}$/)),
  startupGraceMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }))
  ),
});
export const decodeStartOptions = makeThrowingDecoder(StartOptionsSchema, {
  onExcessProperty: 'error',
});

async function listen(server: Server, endpoint: string): Promise<Server> {
  await new Promise<void>((resolve, reject) => {
    const failed = (cause: Error): void => {
      server.off('listening', ready);
      reject(cause);
    };
    const ready = (): void => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(endpoint);
  });
  return server;
}
async function prepareSocketDirectory(root: string): Promise<string> {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const directory = join(await realpath(tmpdir()), `bs-h-${hash}`);
  const socket = join(directory, 's');
  if (Buffer.byteLength(socket) > 99) {
    throw new Error('Host socket path exceeds the portable Unix socket limit');
  }
  await secureDirectory(directory);
  try {
    if (!(await lstat(socket)).isSocket()) {
      throw new Error('Host endpoint path is occupied by a non-socket');
    }
    await rm(socket);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  return directory;
}
export async function startHost(
  input: HostStartOptions,
  bindings?: HostRuntimeBindings,
  signal?: AbortSignal
): Promise<HostRuntime> {
  signal?.throwIfAborted();
  const options = decodeStartOptions(input);
  if (!isAbsolute(options.root)) {
    throw new TypeError('Host data root must be absolute');
  }
  if (options.lifetime === 'app' && !options.parent) {
    throw new TypeError('An app host requires its parent PID/start identity');
  }
  assertNotSyncedRoot(options.root);
  await secureDirectory(options.root);
  const owner = new ResourceOwner();
  const sockets = new Set<Socket>();
  const completion = Promise.withResolvers<void>();
  // Preserve fatal cleanup failures on the public closed Promise without an
  // unhandled-rejection race before the launcher has received the runtime.
  completion.promise.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const rootJoined = Promise.withResolvers<void>();
  rootJoined.promise.catch(() => undefined);
  let serverClosing: Promise<void> | undefined;
  let stopReply: { readonly socket: Socket; readonly finished: Promise<void> } | undefined;
  let clients = 0;
  let activeRuns = 0;
  let attachedOnce = false;
  const close = (cause?: unknown): Promise<void> => {
    if (!closing) {
      // BST-1977: fence Core before metadata/ACL and transport finalizers.
      // Latch first: retirement can synchronously release a run or reenter close.
      closing = completion.promise;
      const failures: unknown[] = [];
      try {
        bindings?.beginClose?.();
      } catch (failure) {
        failures.push(failure);
      }
      const rootClosing = owner.close().then(
        () => {
          if (failures.length > 0) {
            throw failures[0];
          }
        },
        (failure: unknown) => {
          if (failures.length > 0 && failures[0] !== failure) {
            throw new AggregateError([...failures, failure], 'Host retirement and cleanup failed');
          }
          throw failure;
        }
      );
      rootClosing.then(rootJoined.resolve, rootJoined.reject);
      void (async () => {
        try {
          await rootClosing;
          if (cause !== undefined) {
            throw cause;
          }
        } finally {
          if (stopReply) {
            // BST-1977 host/stop: successful replies follow physical platform
            // joins and Root release, then the actual JSON-RPC writer joins
            // before this last transport is destroyed. Client loss also
            // settles finished; it never substitutes for Root cleanup.
            await stopReply.finished;
            await destroySocket(stopReply.socket);
            await serverClosing;
          }
        }
      })().then(completion.resolve, completion.reject);
    }
    return closing;
  };
  const finishIfIdle = (): void => {
    if (
      options.lifetime === 'cli' &&
      attachedOnce &&
      clients === 0 &&
      activeRuns === 0 &&
      !closing
    ) {
      close().catch(() => undefined); // failure stays visible on completion.promise
    }
  };
  const retainRun = (): (() => void) => {
    signal?.throwIfAborted();
    if (closing) {
      throw new Error('Host is closing');
    }
    activeRuns += 1;
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      activeRuns -= 1;
      finishIfIdle();
    };
  };
  try {
    signal?.throwIfAborted();
    const lease = bindings
      ? (
          await owner.acquire(
            () => bindings.acquireRoot(retainRun),
            (resource) => resource.close()
          )
        ).lock
      : await owner.acquire(
          // ADR-0017: the native processes this host starts inherit its Root.
          () => RootLock.acquire(options.root, { shareWithNativeChildren: true }),
          async (lock) => lock.release()
        );
    signal?.throwIfAborted();
    const canonicalRoot = lease.owner.root;
    const token = randomBytes(32).toString('hex');
    let endpoint: string;
    if (process.platform === 'win32') {
      endpoint = `\\\\.\\pipe\\brainstrike-${createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 24)}`;
    } else {
      const directory = await owner.acquire(
        () => prepareSocketDirectory(canonicalRoot),
        (value) => rm(value, { force: true, recursive: true })
      );
      endpoint = join(directory, 's');
    }
    const record: HostRecord = {
      endpoint,
      hostVersion: HOST_VERSION,
      pid: process.pid,
      protocolVersion: bindings?.protocolVersion ?? PROTOCOL_VERSION,
      start: lease.owner.start,
      token,
    };
    const server = createServer((socket: Socket) => {
      sockets.add(socket);
      let initialized = false;
      let attached = false;
      let rejected = false;
      if (bindings) {
        socket.on('error', () => socket.destroy());
        socket.once('close', () => {
          sockets.delete(socket);
          if (attached) {
            clients -= 1;
            finishIfIdle();
          }
        });
        bindings.acceptSocket(
          socket,
          record,
          () => {
            if (attached || closing || signal?.aborted) {
              throw new Error('Host attachment is already initialized or closing');
            }
            attached = true;
            attachedOnce = true;
            clients += 1;
          },
          {
            get closing(): boolean {
              return closing !== undefined;
            },
            stop: (finished) => {
              if (closing || !attached) {
                return Promise.reject(new Error('Host is closing or unauthenticated'));
              }
              stopReply = { finished, socket };
              void close().catch(() => undefined);
              return rootJoined.promise;
            },
          }
        );
        return;
      }
      const reject = (message: string): void => {
        if (rejected) {
          return;
        }
        rejected = true;
        socket.end(`${JSON.stringify({ message, method: 'error' })}\n`);
      };
      const request = (frame: HostRequest): void => {
        if (rejected || closing || signal?.aborted) {
          reject('Host is closing');
          return;
        }
        if (frame.method === 'initialize') {
          if (
            initialized ||
            frame.protocolVersion !== record.protocolVersion ||
            frame.hostVersion !== record.hostVersion
          ) {
            reject('Host protocol or host version mismatch');
            return;
          }
          if (!tokensEqual(record.token, frame.token)) {
            reject('Host token authentication failed');
            return;
          }
          initialized = true;
          sendFrame(socket, {
            hostVersion: record.hostVersion,
            method: 'initialized',
            pid: record.pid,
            protocolVersion: record.protocolVersion,
            start: record.start,
          });
          return;
        }
        if (!initialized || attached) {
          reject('Host attach requires exactly one initialize');
          return;
        }
        attached = true;
        attachedOnce = true;
        clients += 1;
        sendFrame(socket, { method: 'attached' });
      };
      receiveFrames(socket, decodeRequest, request, () => reject('Invalid host handshake frame'));
      socket.on('error', () => socket.destroy());
      socket.once('close', () => {
        sockets.delete(socket);
        if (attached) {
          clients -= 1;
          finishIfIdle();
        }
      });
    });
    await owner.acquire(
      () => listen(server, endpoint),
      async (value) => {
        serverClosing = new Promise<void>((resolve, reject) =>
          value.close((error?: Error) => (error ? reject(error) : resolve()))
        );
        serverClosing.catch(() => undefined);
        await Promise.all(
          [...sockets].filter((socket) => socket !== stopReply?.socket).map(destroySocket)
        );
        if (!stopReply) {
          await serverClosing;
        }
      }
    );
    server.on('error', (cause: Error) => {
      close(cause).catch(() => undefined);
    });
    if (process.platform !== 'win32') {
      await chmod(endpoint, 0o600);
    }
    await owner.acquire(
      async () => record,
      (value) => removeOwnHostRecord(canonicalRoot, value)
    );
    await publishHostRecord(canonicalRoot, record);
    signal?.throwIfAborted();
    if (closing) {
      await closing;
      throw new Error('Host closed during startup');
    }
    if (options.lifetime !== 'persistent') {
      await owner.acquire(
        async () =>
          setTimeout(() => {
            if (!attachedOnce && activeRuns === 0) {
              close().catch(() => undefined);
            }
          }, options.startupGraceMs ?? 10_000),
        async (timer) => clearTimeout(timer)
      );
    }
    // "A host forked by the app dies with the app" (ADR-0017). The app is checked once here; after
    // that the host lives exactly as long as its launcher's lifetime channel (the Node IPC channel,
    // or Electron Main's lifetime port), which the process entry turns into close(). A channel's peer
    // is the app process itself, so a later process reusing the app's pid cannot keep a host alive.
    if (
      options.lifetime === 'app' &&
      options.parent &&
      processStartTime(options.parent.pid) !== options.parent.start
    ) {
      await close();
      throw new Error('App parent is not alive at host startup');
    }
    return {
      get clientCount(): number {
        return clients;
      },
      close: () => close(),
      closed: completion.promise,
      record,
      retainRun,
    };
  } catch (cause) {
    try {
      await close();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Host startup and cleanup failed');
    }
    throw cause;
  }
}
