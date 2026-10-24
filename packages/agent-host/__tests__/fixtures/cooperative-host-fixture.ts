import { createHash } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { recordFixtureEvent } from './owned-fixture-process.ts';

export interface FixtureStartupObserver {
  readonly close: () => Promise<void>;
  readonly endpoint: string;
  readonly fail: (cause: unknown) => void;
  readonly joined: Promise<number>;
  readonly ready: Promise<number>;
  readonly spawned: Promise<number>;
}

/** Test-only stream: the production starter's IPC protocol remains its sole startup authority. */
export async function observeFixtureStartup(
  root: string,
  signal: AbortSignal
): Promise<FixtureStartupObserver> {
  signal.throwIfAborted();
  const name = createHash('sha256').update(resolve(root)).digest('hex');
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\bs-m3-fixture-startup-${name}`
      : join(root, 'fixture-startup.sock');
  const spawned = Promise.withResolvers<number>();
  const ready = Promise.withResolvers<number>();
  const joined = Promise.withResolvers<number>();
  void spawned.promise.catch(() => undefined);
  void ready.promise.catch(() => undefined);
  void joined.promise.catch(() => undefined);
  const sockets = new Set<Socket>();
  const fail = (cause: unknown): void => {
    spawned.reject(cause);
    ready.reject(cause);
  };
  const abort = (): void => fail(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let observedReady = false;
    let observedJoin = false;
    socket.setEncoding('utf8');
    socket.on('error', fail);
    socket.once('close', () => {
      sockets.delete(socket);
      if (!observedReady) {
        fail(new Error('Fixture readiness stream closed before the child-pid marker'));
      }
      if (!observedJoin) {
        joined.reject(new Error('Fixture readiness stream closed before physical cleanup joined'));
      }
    });
    socket.on('data', (value: string) => {
      buffer += value;
      let newline = buffer.indexOf('\n');
      try {
        while (newline >= 0) {
          const event: unknown = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!(event && typeof event === 'object' && 'event' in event)) {
            throw new Error('Invalid fixture readiness event');
          }
          if (event.event === 'failed' && 'message' in event && typeof event.message === 'string') {
            // Rejection precedes the registered join; keep its observation stream open.
            fail(new Error(event.message));
            recordFixtureEvent('startup-fixture-failure', { message: event.message });
            newline = buffer.indexOf('\n');
            continue;
          }
          if (
            !('pid' in event) ||
            typeof event.pid !== 'number' ||
            !Number.isSafeInteger(event.pid) ||
            event.pid <= 0
          ) {
            throw new Error('Invalid fixture readiness PID');
          }
          if (event.event === 'spawned') {
            spawned.resolve(event.pid);
          } else if (event.event === 'ready') {
            observedReady = true;
            ready.resolve(event.pid);
            // Initializer rejection must follow observation of the actual marker.
            socket.write('accepted\n');
          } else if (event.event === 'joined') {
            observedJoin = true;
            joined.resolve(event.pid);
          } else {
            throw new Error('Unknown fixture readiness event');
          }
          recordFixtureEvent('startup-fixture-event', event);
          newline = buffer.indexOf('\n');
        }
      } catch (cause) {
        fail(cause);
        socket.destroy();
      }
    });
  });
  server.on('error', fail);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      signal.removeEventListener('abort', abort);
      fail(new Error('Fixture readiness observer closed'));
      joined.reject(new Error('Fixture readiness observer closed before cleanup joined'));
      const closedSockets = [...sockets].map(
        (socket) => new Promise<void>((resolveClose) => socket.once('close', resolveClose))
      );
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveClose, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolveClose()));
      });
      await Promise.all(closedSockets);
    })());
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    return {
      close,
      endpoint,
      fail,
      joined: joined.promise,
      ready: ready.promise,
      spawned: spawned.promise,
    };
  } catch (cause) {
    signal.removeEventListener('abort', abort);
    server.close();
    throw cause;
  }
}

/** Resolve the disposable target before deletion; retain failed/live leases. */
export async function removeFixtureRoot(root: string): Promise<void> {
  const target = await realpath(root);
  const location = relative(await realpath(tmpdir()), target);
  if (
    !location ||
    location === '..' ||
    location.startsWith(`..${sep}`) ||
    isAbsolute(location) ||
    !basename(target).startsWith('bs-m3-')
  ) {
    throw new Error('Refusing removal outside the allocated fixture temp directory');
  }
  const owner = RootLock.inspect(target)?.owner;
  // A released generation can belong to the still-live Vitest coordinator
  // after StateStore reopen/close; the released marker owns that fact.
  if (owner && !owner.released) {
    throw new Error('Retaining fixture root with an unreleased owner');
  }
  await rm(target, { force: true, recursive: true });
  recordFixtureEvent('owned-fixture-root-removed', { root: target });
}
