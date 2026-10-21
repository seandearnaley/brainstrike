import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import { Message, RAL, StreamMessageReader } from 'vscode-jsonrpc/node';
import { attachAgentHost } from '../src/client.js';
import { startAgentHost } from '../src/runtime.js';

test('retirement answers a complete frame still decoding when the last dispatch settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-retiring-receive-'));
  const entered = Promise.withResolvers<void>();
  const releaseRequest = Promise.withResolvers<void>();
  const decoding = Promise.withResolvers<void>();
  const releaseDecoder = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<Socket>();
  const stopping = Promise.withResolvers<void>();
  const readers = new Set<StreamMessageReader>();
  const ral = RAL();
  let holdDecoder = false;
  RAL.install({
    ...ral,
    applicationJson: {
      ...ral.applicationJson,
      decoder: {
        ...ral.applicationJson.decoder,
        decode: async (bytes, options) => {
          const message = await ral.applicationJson.decoder.decode(bytes, options);
          if (
            holdDecoder &&
            Message.isRequest(message) &&
            message.method === 'host/workspace-roots'
          ) {
            decoding.resolve();
            await releaseDecoder.promise;
          }
          return message;
        },
      },
    },
  });
  const emit: (event: string | symbol, ...args: unknown[]) => boolean = Server.prototype.emit;
  const serverEvents = vi.spyOn(Server.prototype, 'emit').mockImplementation(function (
    this: Server,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === 'connection' && args[0] instanceof Socket) {
      accepted.resolve(args[0]);
    }
    return emit.call(this, event, ...args);
  });
  const close = Server.prototype.close;
  const serverClose = vi.spyOn(Server.prototype, 'close').mockImplementation(function (
    this: Server,
    callback
  ) {
    stopping.resolve();
    return close.call(this, callback);
  });
  const listen = StreamMessageReader.prototype.listen;
  const readerListen = vi
    .spyOn(StreamMessageReader.prototype, 'listen')
    .mockImplementation(function (this: StreamMessageReader, callback) {
      readers.add(this);
      return listen.call(this, callback);
    });
  const host = await startAgentHost({ lifetime: 'persistent', root }, ({ store }) => {
    const workspaceRoots = store.workspaceRoots.bind(store);
    vi.spyOn(store, 'workspaceRoots').mockImplementation(async (request) => {
      const reply = await workspaceRoots(request);
      if (request.operation === 'register') {
        entered.resolve();
        await releaseRequest.promise;
      }
      return reply;
    });
    return {
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      tools: {},
    };
  });
  const client = await attachAgentHost(host.record);
  const socket = await accepted.promise;
  const pause = socket.pause.bind(socket);
  const inputFence = vi.spyOn(socket, 'pause').mockImplementation(() => {
    const paused = pause();
    releaseDecoder.resolve();
    return paused;
  });
  // On the broken implementation this is the first terminal boundary. Releasing
  // the decoder after physical close cannot rescue the refused request.
  socket.once('close', () => releaseDecoder.resolve());
  try {
    const registering = client.catalog.workspaceRoots({
      operation: 'register',
      root: { displayName: 'workspace', path: root, preferredId: randomUUID() },
    });
    await entered.promise;
    const closing = host.close();
    await stopping.promise;
    // Establish that earlier frames have decoded, including any reader drain
    // already started by close. No test assertion depends on close calling it.
    await Promise.all([...readers].map((reader) => reader.drain()));
    holdDecoder = true;
    const refused = client.catalog
      .workspaceRoots({ operation: 'list' })
      .catch((cause: unknown) => cause);
    await decoding.promise;
    releaseRequest.resolve();
    await registering;
    expect(await refused).toMatchObject({ code: 'host.closing', failure: { kind: 'refusal' } });
    await closing;
  } finally {
    releaseRequest.resolve();
    releaseDecoder.resolve();
    await client.close();
    await host.close();
    inputFence.mockRestore();
    readerListen.mockRestore();
    serverClose.mockRestore();
    serverEvents.mockRestore();
    RAL.install(ral);
    await rm(root, { force: true, recursive: true });
  }
});
