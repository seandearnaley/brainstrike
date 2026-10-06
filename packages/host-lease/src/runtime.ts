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
  acceptSocket(socket: Socket, record: HostRecord, attached: () => void): void;
  acquireRoot(
    retainRun: () => () => void
  ): Promise<{ readonly lock: RootLock; close(): Promise<void> }>;
  readonly protocolVersion: number;
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
async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  await Promise.all([...sockets].map(destroySocket));
  await new Promise<void>((resolve, reject) =>
    server.close((error?: Error) => (error ? reject(error) : resolve()))
  );
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
  let clients = 0;
  let activeRuns = 0;
  let attachedOnce = false;
  const close = (cause?: unknown): Promise<void> => {
    if (!closing) {
      closing = owner.close().then(() => {
        if (cause !== undefined) {
          throw cause;
        }
      });
      closing.then(completion.resolve, completion.reject);
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
          () => RootLock.acquire(options.root),
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
        bindings.acceptSocket(socket, record, () => {
          if (attached || closing || signal?.aborted) {
            throw new Error('Host attachment is already initialized or closing');
          }
          attached = true;
          attachedOnce = true;
          clients += 1;
        });
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
      (value) => closeServer(value, sockets)
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
    if (options.lifetime === 'app' && options.parent) {
      const parent = options.parent;
      if (processStartTime(parent.pid) !== parent.start) {
        await close();
        throw new Error('App parent is not alive at host startup');
      }
      await owner.acquire(
        async () =>
          setInterval(() => {
            try {
              if (processStartTime(parent.pid) !== parent.start) {
                close().catch(() => undefined);
              }
            } catch (cause) {
              close(cause).catch(() => undefined);
            }
          }, 100),
        async (timer) => clearInterval(timer)
      );
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
