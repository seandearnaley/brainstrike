import { PassThrough, Writable } from 'node:stream';
import { BoundaryFailureError, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import type { HostRecord } from '@brainstrike/host-lease';
import { expect, test } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { isConnectionLoss } from '../src/boundary-wire.js';
import { authenticateHostClient, type HostClient } from '../src/client-connection.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol.js';
import { stdioConnection } from '../src/transports.js';

const record: HostRecord = {
  endpoint: '/tmp/unused-peer-reset-fixture',
  hostVersion: '0.1.0',
  pid: 1,
  protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
  start: 'fixture',
  token: 'a'.repeat(64),
};

/**
 * Real JSON-RPC frames to a fake host. After `endTransport`, the client's next
 * write fails as Node's socket fails it once the host has closed its end.
 */
async function connect(): Promise<{
  client: HostClient;
  endTransport(failure: Error): void;
}> {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = stdioConnection(input, output);
  server.onRequest('initialize', () => ({
    hostVersion: record.hostVersion,
    pid: record.pid,
    protocolVersion: record.protocolVersion,
    start: record.start,
  }));
  server.listen();
  let ended: Error | undefined;
  const writes = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (ended) {
        done(ended);
        return;
      }
      input.write(chunk, done);
    },
  });
  const closed = Promise.withResolvers<void>();
  const client = await authenticateHostClient(
    createMessageConnection(new StreamMessageReader(output), new StreamMessageWriter(writes)),
    record,
    async () => {
      server.dispose();
      input.destroy();
      output.destroy();
      closed.resolve();
    },
    closed.promise
  );
  return {
    client,
    endTransport: (failure) => {
      ended = failure;
    },
  };
}

const peerReset = (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

// BST-2192: a signal to Main's process group closes the agent host too. A catalog
// read Main's scan writes after the host closed its end fails with EPIPE; that
// request never reached the host, so its connection was lost.
test.each([
  [
    'a catalog request',
    (client: HostClient) => client.catalog.sourceCatalog({ operation: 'list' }),
  ],
  ['a host request', (client: HostClient) => client.request('thread/list', {})],
])('%s written after the host closed the transport reads as a lost connection', async (_, send) => {
  const { client, endTransport } = await connect();
  try {
    endTransport(peerReset());
    const failure = await send(client).catch((cause: unknown) => cause);
    expect(isConnectionLoss(failure)).toBe(true);
    expect(failure).toMatchObject({ failure: { code: 'host.connection-lost' } });
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('a write failure the peer did not cause stays the internal fault', async () => {
  const { client, endTransport } = await connect();
  try {
    endTransport(Object.assign(new Error('write EBADF'), { code: 'EBADF' }));
    const failure = await client.catalog
      .sourceCatalog({ operation: 'list' })
      .catch((cause: unknown) => cause);
    expect(isConnectionLoss(failure)).toBe(false);
    expect(failure).toBeInstanceOf(BoundaryFailureError);
    expect((failure as BoundaryFailureError).failure).toEqual(INTERNAL_FAULT);
  } finally {
    await client.close().catch(() => undefined);
  }
});

// A host killed while a request is in flight never answers it: the transport's close
// fails the request instead of leaving its caller waiting for good.
test.each([
  ['initialize', false],
  ['a host request', true],
] as const)('%s pending when the transport closes rejects', async (_name, initialized) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = stdioConnection(input, output);
  const held = Promise.withResolvers<void>();
  server.onRequest('initialize', async () => {
    if (!initialized) {
      await held.promise;
    }
    return {
      hostVersion: record.hostVersion,
      pid: record.pid,
      protocolVersion: record.protocolVersion,
      start: record.start,
    };
  });
  server.onRequest('thread/list', () => held.promise);
  server.listen();
  const closed = Promise.withResolvers<void>();
  const client = authenticateHostClient(
    stdioConnection(output, input),
    record,
    async () => undefined,
    closed.promise
  );
  const pending = initialized
    ? client.then((authenticated) => authenticated.request('thread/list', {}))
    : client;
  if (initialized) {
    await client;
  } else {
    await new Promise((resolve) => setImmediate(resolve));
  }
  closed.resolve();
  await expect(pending).rejects.toThrow();
  held.resolve();
  server.dispose();
});
