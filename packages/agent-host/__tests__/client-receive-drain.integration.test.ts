import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { HOST_VERSION, type HostRecord } from '@brainstrike/host-lease';
import { expect, test } from 'vitest';
import {
  createMessageConnection,
  ErrorCodes,
  type Message,
  Message as Messages,
  type NotificationMessage,
  type ResponseMessage,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { authenticateHostClient, type HostClient } from '../src/client-connection.js';
import { closeReceivedConnection } from '../src/client-receive-lifetime.js';
import { AGENT_HOST_PROTOCOL_VERSION, HostLogRowSchema } from '../src/protocol.js';

// Captured from the actual authenticated Core/SQLite Stop proof on 889d9094;
// only the transient response ID is rebound to the fixture's received request.
const stopResponse: unknown = JSON.parse(
  await readFile(new URL('./fixtures/recorded-host-stop-response.json', import.meta.url), 'utf8')
);
const rows = HostLogRowSchema.array()
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          '../../../apps/desktop/src/__tests__/fixtures/committed-approved-host-run.json',
          import.meta.url
        ),
        'utf8'
      )
    )
  )
  .slice(0, 3);

type Fault =
  | 'complete'
  | 'multiple'
  | 'missing'
  | 'partial'
  | 'malformed'
  | 'wrong-id'
  | 'stop-error'
  | 'decoder-error'
  | 'dispatch-error'
  | 'dispatch-sync-error'
  | 'decoder-dispose-error'
  | 'concurrent-close'
  | 'dispose-error';

async function encodedFrame(message: Message): Promise<Buffer> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const writer = new StreamMessageWriter(stream);
  try {
    await writer.write(message);
    return Buffer.concat(chunks);
  } finally {
    writer.dispose();
    stream.destroy();
  }
}

test.each(['decoder', 'dispatch'] as const)(
  'joins complete received Stop frames held in %s before physical-close disposal',
  async (stage) => {
    await exercise('complete', stage);
  }
);
test.each([
  'multiple',
  'missing',
  'partial',
  'malformed',
  'wrong-id',
  'stop-error',
  'decoder-error',
  'dispatch-error',
  'dispatch-sync-error',
  'decoder-dispose-error',
  'dispose-error',
] as const)('preserves response/error and physical cleanup for %s', async (fault) => {
  await exercise(fault);
});
test('joins a registered dispatch drain when explicit close discards its queued response', async () => {
  await exercise('concurrent-close', 'decoder');
});

async function exercise(fault: Fault, stage?: 'decoder' | 'dispatch'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-receive-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\brainstrike-${randomBytes(16).toString('hex')}`
      : join(root, 'rpc.sock');
  const physical = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  completion.promise.catch(() => undefined);
  const held = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const injectedFailure = new Error('Synthetic receive lifetime failure');
  const disposalFailure = new Error('Independent disposal failure');
  const failures = new Set<unknown>();
  const requests: string[] = [];
  const peers = new Set<Socket>();
  const peerClosures: Promise<void>[] = [];
  const record: HostRecord = {
    endpoint,
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'isolated-recorded-transport',
    token: randomBytes(32).toString('hex'),
  };
  const server = createServer((peer: Socket): void => {
    peers.add(peer);
    peerClosures.push(new Promise<void>((resolve) => peer.once('close', resolve)));
    const reader = new StreamMessageReader(peer);
    const writer = new StreamMessageWriter(peer);
    peer.once('close', () => {
      peers.delete(peer);
      reader.dispose();
      writer.dispose();
    });
    reader.listen((message: Message): void => {
      if (!Messages.isRequest(message)) {
        throw new Error('Fixture received a non-request');
      }
      requests.push(message.method);
      void (async (): Promise<void> => {
        if (message.method === 'initialize') {
          expect(message.params).toMatchObject({ token: record.token });
          const initialized: ResponseMessage = {
            id: message.id,
            jsonrpc: '2.0',
            result: {
              hostVersion: record.hostVersion,
              pid: record.pid,
              protocolVersion: record.protocolVersion,
              start: record.start,
            },
          };
          await writer.write(initialized);
          return;
        }
        expect(message.method).toBe('host/stop');
        if (fault === 'multiple') {
          for (const row of rows) {
            const notification: NotificationMessage = {
              jsonrpc: '2.0',
              method: 'log/event',
              params: row,
            };
            await writer.write(notification);
          }
        }
        const response: ResponseMessage = {
          ...(stopResponse as ResponseMessage),
          id: fault === 'wrong-id' ? `unowned-${message.id}` : message.id,
        };
        if (fault === 'missing') {
          peer.end();
          return;
        }
        if (fault === 'partial' || fault === 'malformed') {
          const frame = await encodedFrame(response);
          if (fault === 'malformed') {
            frame[frame.indexOf('\r\n\r\n') + 4] = '!'.charCodeAt(0);
          }
          peer.end(fault === 'partial' ? frame.subarray(0, frame.length - 3) : frame);
          return;
        }
        await writer.write(
          fault === 'stop-error'
            ? {
                error: { code: ErrorCodes.InternalError, message: 'Synthetic cleanup failure' },
                id: message.id,
                jsonrpc: '2.0',
              }
            : response
        );
        peer.end();
      })().catch((cause: unknown) => {
        failures.add(cause);
        peer.destroy();
      });
    });
  });
  const socket = new Socket();
  socket.once('close', () => physical.resolve());
  socket.on('error', (cause: Error) => failures.add(cause));
  let client: HostClient | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.connect(endpoint);
    });
    const reader = new StreamMessageReader(socket, {
      contentTypeDecoder: {
        decode: async (bytes: Uint8Array): Promise<Message> => {
          const message = JSON.parse(Buffer.from(bytes).toString('utf8')) as Message;
          if (Messages.isResponse(message) && message.id === 1) {
            if (fault === 'decoder-error' || fault === 'decoder-dispose-error') {
              throw injectedFailure;
            }
            if (stage === 'decoder') {
              held.resolve();
              await gate.promise;
            }
          }
          return message;
        },
        name: 'application/json',
      },
    });
    const listen = reader.listen.bind(reader);
    reader.listen = (callback) =>
      listen((message: Message): void => {
        callback(message);
        if (fault === 'concurrent-close' && Messages.isResponse(message) && message.id === 1) {
          // Physical close was observed while this complete frame's decoder was
          // held. Its public callback has now admitted it to the dispatch queue.
          expect(socket.closed).toBe(true);
          void closeReceivedConnection(undefined, connection, failures).then(
            completion.resolve,
            completion.reject
          );
        }
      });
    const connection = createMessageConnection(reader, new StreamMessageWriter(socket), undefined, {
      messageStrategy: {
        handleMessage: (
          message: Message,
          next: (message: Message) => void | Promise<void>
        ): void | Promise<void> => {
          if (Messages.isResponse(message) && message.id === 1) {
            if (fault === 'dispatch-error') {
              return Promise.reject(injectedFailure);
            }
            if (fault === 'dispatch-sync-error') {
              throw injectedFailure;
            }
            if (stage === 'dispatch') {
              held.resolve();
              return gate.promise.then(() => next(message));
            }
          }
          return next(message);
        },
      },
    });
    if (fault === 'concurrent-close') {
      const drain = connection.drain.bind(connection);
      connection.drain = (): Promise<void> => {
        const pending = drain();
        // Interleave the real client finalizer after queue-drain registration
        // and before the SDK's queued dispatch, using only its public methods.
        void client?.close().catch((cause: unknown) => failures.add(cause));
        return pending;
      };
    }
    connection.onError(([cause]) => failures.add(cause));
    if (fault === 'dispose-error' || fault === 'decoder-dispose-error') {
      const dispose = connection.dispose.bind(connection);
      connection.dispose = (): void => {
        dispose();
        throw fault === 'decoder-dispose-error' ? disposalFailure : injectedFailure;
      };
    }
    socket.once('close', () => {
      if (fault !== 'concurrent-close') {
        void closeReceivedConnection(reader, connection, failures).then(
          completion.resolve,
          completion.reject
        );
      }
    });
    client = await authenticateHostClient(
      connection,
      record,
      async (): Promise<void> => {
        socket.destroy();
        await completion.promise;
      },
      completion.promise
    );
    const received: unknown[] = [];
    client.onEvent((row) => received.push(row));
    let retired = false;
    client.closed
      .finally(() => {
        retired = true;
      })
      .catch(() => undefined);
    const response = Promise.allSettled([client.request('host/stop', {})]);
    if (stage) {
      await held.promise;
      await physical.promise;
      expect(retired).toBe(false);
      gate.resolve();
    }
    const [result] = await response;
    if (fault === 'concurrent-close') {
      await reader.drain();
      expect(retired).toBe(true);
    }
    if (fault === 'complete' || fault === 'multiple' || fault === 'dispose-error') {
      expect(result).toEqual({
        status: 'fulfilled',
        value: { outcome: 'stopped', rootReleased: true },
      });
    } else {
      expect(result?.status).toBe('rejected');
      if (result?.status === 'rejected') {
        expect(result.reason).toMatchObject({
          code:
            fault === 'stop-error' ? ErrorCodes.InternalError : ErrorCodes.PendingResponseRejected,
        });
      }
    }
    if (
      [
        'malformed',
        'decoder-error',
        'dispatch-error',
        'dispatch-sync-error',
        'decoder-dispose-error',
        'dispose-error',
      ].includes(fault)
    ) {
      if (fault === 'decoder-dispose-error') {
        const failure: unknown = await client.closed.catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(AggregateError);
        if (failure instanceof AggregateError) {
          expect(new Set<unknown>(failure.errors)).toEqual(
            new Set([injectedFailure, disposalFailure])
          );
        }
      } else if (fault === 'decoder-error' || fault === 'dispose-error') {
        await expect(client.closed).rejects.toBe(injectedFailure);
      } else if (fault === 'dispatch-error' || fault === 'dispatch-sync-error') {
        await expect(client.closed).rejects.toMatchObject({ errors: [injectedFailure] });
      }
      await expect(client.closed).rejects.toBeInstanceOf(Error);
      await expect(client.close()).rejects.toBeInstanceOf(Error);
    } else {
      await client.closed;
      await client.close();
      await client.close();
    }
    expect(socket.closed).toBe(true);
    await expect(client.request('thread/list', {})).rejects.toBeInstanceOf(Error);
    expect(requests).toEqual(['initialize', 'host/stop']);
    expect(received).toEqual(fault === 'multiple' ? rows : []);
  } finally {
    gate.resolve();
    socket.destroy();
    await client?.close().catch(() => undefined);
    for (const peer of peers) {
      peer.destroy();
    }
    await Promise.all(peerClosures);
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause ? reject(cause) : resolve()))
    );
    await rm(root, { force: true, recursive: true });
  }
}
