import { PassThrough } from 'node:stream';
import type { HostRecord } from '@brainstrike/host-lease';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import { afterEach, expect, test } from 'vitest';
import { authenticateHostClient } from '../src/client-connection.js';
import { AGENT_HOST_PROTOCOL_VERSION, type HostLogRow } from '../src/protocol.js';
import { stdioConnection } from '../src/transports.js';

const rows = recording as unknown as HostLogRow[];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

// Real JSON-RPC frames between a fake host and the client, with no host process.
async function connect() {
  const input = new PassThrough();
  const output = new PassThrough();
  const host = stdioConnection(input, output);
  const record: HostRecord = {
    endpoint: '/tmp/unused-notification-fixture',
    hostVersion: '0.1.0',
    pid: 1,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'fixture',
    token: 'a'.repeat(64),
  };
  host.onRequest('initialize', () => ({
    hostVersion: record.hostVersion,
    pid: record.pid,
    protocolVersion: record.protocolVersion,
    start: record.start,
  }));
  host.listen();
  const closed = Promise.withResolvers<void>();
  const client = await authenticateHostClient(
    stdioConnection(output, input),
    record,
    async () => {
      host.dispose();
      input.destroy();
      output.destroy();
      closed.resolve();
    },
    closed.promise
  );
  closers.push(() => client.close());
  const state = { closed: false };
  void client.closed.then(() => {
    state.closed = true;
  });
  return { client, host, state };
}

test('a view that throws on a live row closes the connection, and every other view still gets the row', async () => {
  const { client, host, state } = await connect();
  const other: number[] = [];
  client.onEvent(() => {
    throw new Error('this view failed to render the row');
  });
  client.onEvent((row) => other.push(row.seq));
  const [first] = rows;
  await host.sendNotification('log/event', first);
  await expect.poll(() => other).toEqual([first?.seq]);
  // Closed, the owner's host-lost path reconnects and replays the thread from its start.
  await expect.poll(() => state.closed).toBe(true);
});

test('a live row the client cannot read closes the connection instead of leaving a gap', async () => {
  const { client, host, state } = await connect();
  const received: number[] = [];
  client.onEvent((row) => received.push(row.seq));
  const [first, second] = rows;
  await host.sendNotification('log/event', first);
  await host.sendNotification('log/event', { ...second, unknownField: true });
  await expect.poll(() => state.closed).toBe(true);
  expect(received).toEqual([first?.seq]);
});
