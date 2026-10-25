import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_VERSION, type HostRecord } from '@brainstrike/host-lease';
import { afterEach, expect, test, vi } from 'vitest';
import { isConnectionLoss } from '../src/boundary-wire.js';
import { attachAgentHost } from '../src/client.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol.js';
import { stdioConnection } from '../src/transports.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A host answering `initialize` on a real local socket, with the client's and its own socket. */
async function attachToFakeHost() {
  const directory = await mkdtemp(join(tmpdir(), 'bs-client-transport-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\bs-client-transport-${crypto.randomUUID()}`
      : join(directory, 's');
  const record: HostRecord = {
    endpoint,
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'fixture',
    token: 'a'.repeat(64),
  };
  const accepted = Promise.withResolvers<Socket>();
  const server: Server = createServer((socket) => {
    const connection = stdioConnection(socket, socket);
    connection.onRequest('initialize', () => ({
      hostVersion: record.hostVersion,
      pid: record.pid,
      protocolVersion: record.protocolVersion,
      start: record.start,
    }));
    connection.listen();
    socket.once('close', () => connection.dispose());
    accepted.resolve(socket);
  });
  server.listen(endpoint);
  await once(server, 'listening');
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  });
  const connecting = vi.spyOn(Socket.prototype, 'connect');
  const client = await attachAgentHost(record);
  const own = connecting.mock.contexts[0];
  connecting.mockRestore();
  if (!(own instanceof Socket)) {
    throw new Error('The client connected no socket');
  }
  return { client, host: await accepted.promise, own };
}

test('a host that ends the connection under the client’s writes leaves a clean close', async () => {
  const { client, host, own } = await attachToFakeHost();
  // Hold the client's reads, so its writes meet the host's closed end before
  // the client sees the end of input, as Main's writes do when a host stops.
  own.pause();
  host.destroy();
  await once(host, 'close');
  const failures = await Promise.all(
    Array.from({ length: 3 }, () => client.request('thread/list', {}).catch((cause) => cause))
  );
  own.resume();
  expect(failures.every(isConnectionLoss)).toBe(true);
  await expect(client.closed).resolves.toBeUndefined();
  await expect(client.close()).resolves.toBeUndefined();
});

test('a frame the client cannot decode still fails its close', async () => {
  const { client, host } = await attachToFakeHost();
  host.end('Content-Length: many\r\n\r\n');
  await expect(client.closed).rejects.toThrow('Content-Length value must be a number');
  await expect(client.close()).rejects.toThrow('Content-Length value must be a number');
});
