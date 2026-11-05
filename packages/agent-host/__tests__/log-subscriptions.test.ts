import { MessageChannel } from 'node:worker_threads';
import { HOST_VERSION } from '@brainstrike/host-lease';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import { afterEach, expect, test } from 'vitest';
import { authenticateHostClient } from '../src/client-connection.js';
import { bindHostConnection } from '../src/connection.js';
import type { HostCore } from '../src/core.js';
import type { HostLogRow } from '../src/protocol.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol-version.js';
import { CommittedThreadSession } from '../src/thread-view.js';
import { nodePortConnection } from '../src/transports.js';

const rows = recording as unknown as HostLogRow[];
const threadId = rows[0]?.threadId ?? '';
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A real connection to a fake Core whose log reads fail while `reads.fail` is set. */
async function connect() {
  const reads = { fail: false };
  let commit: ((row: HostLogRow) => void) | undefined;
  const core = {
    hydrated: Promise.resolve(),
    liveTelemetry: { replay: () => [] },
    onCommitted: (listener: (row: HostLogRow) => void) => {
      commit = listener;
      return () => undefined;
    },
    onTelemetry: () => () => undefined,
    published: {
      read: async () => {
        if (reads.fail) {
          throw new Error('The thread store could not be read');
        }
        return [];
      },
    },
    releaseMcpInputClient: () => undefined,
    store: {},
    trees: { changedBy: () => undefined },
  } as unknown as HostCore;
  const record = {
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'start',
  };
  const channel = new MessageChannel();
  const server = nodePortConnection(channel.port1);
  bindHostConnection(server, core, record, () => undefined, { origin: 'desktop-ui' });
  const closed = Promise.withResolvers<void>();
  const client = await authenticateHostClient(
    nodePortConnection(channel.port2),
    record,
    async () => {
      channel.port2.close();
      channel.port1.close();
      server.dispose();
      closed.resolve();
    },
    closed.promise
  );
  closers.push(() => client.close());
  return { client, commit: (row: HostLogRow) => commit?.(row), reads };
}

test('a view whose subscribe fails leaves another view of the thread receiving its rows', async () => {
  const { client, commit, reads } = await connect();
  const open = new CommittedThreadSession(client, threadId);
  open.connect();
  await expect.poll(() => open.getSnapshot().isLoading).toBe(false);
  reads.fail = true;
  const failed = new CommittedThreadSession(client, threadId);
  const closeFailed = failed.connect();
  await expect.poll(() => failed.getSnapshot().error).toBeDefined();
  await closeFailed();
  const [first] = rows;
  if (!first) {
    throw new Error('The recording is empty');
  }
  commit(first);
  await expect.poll(() => open.getSnapshot().rows).toEqual([first]);
});
