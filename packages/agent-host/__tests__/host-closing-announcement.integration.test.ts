import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { isConnectionLoss } from '../src/boundary-wire.js';
import { authenticateHostClient } from '../src/client-connection.js';
import { HOST_CLOSING_EVENT } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { stdioConnection } from '../src/transports.js';

/** A host whose first workspace-root read waits for `release`, as a slow admitted request. */
async function startHeldHost(root: string) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host = await startAgentHost({ lifetime: 'persistent', root }, ({ store }) => {
    const register = store.workspaceRoots.bind(store);

    // Main's catalog transport only reads roots: the first read is the held, admitted request.

    let held = false;
    vi.spyOn(store, 'workspaceRoots').mockImplementation(async (request) => {
      const reply = await register(request);
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return reply;
    });
    return {
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      tools: {},
    };
  });
  return { entered, host, release };
}

/**
 * A visible-UI client on the host's private transport. `dropping` loses the
 * client's later frames in transit, as frames the host never reads before it
 * exits; `exit` ends the transport as the host process's exit does; `cut` ends
 * only the client's side, as a host crash ends it before the host's last frame;
 * `announced` settles once the client has handled the host's retirement announcement.
 */
async function attachPrivateClient(host: AgentHost) {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  host.bindClientConnection(stdioConnection(toHost, toClient), 'desktop-ui');
  const announced = new Promise<void>((resolve) => {
    toClient.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes(HOST_CLOSING_EVENT)) {
        resolve();
      }
    });
  });
  let dropping = false;
  const writes = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (dropping) {
        done();
        return;
      }
      toHost.write(chunk, done);
    },
  });
  const reader = new StreamMessageReader(toClient);
  const connection = createMessageConnection(reader, new StreamMessageWriter(writes));
  const closed = Promise.withResolvers<void>();
  const exit = (): void => {
    toHost.destroy();
    toClient.destroy();
    connection.dispose();
    closed.resolve();
  };
  const client = await authenticateHostClient(
    connection,
    host.record,
    async () => exit(),
    closed.promise
  );
  return {
    // The tap sees the frame before the reader decodes it; the drains join its dispatch.
    announced: announced.then(async () => {
      await reader.drain();
      await connection.drain();
    }),
    client,
    cut: (): void => {
      connection.dispose();
      closed.resolve();
    },
    drop: () => {
      dropping = true;
    },
    exit,
  };
}

test('a retiring host answers what it read, and its client refuses what the host never read as host.closing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-closing-announcement-'));
  const { entered, host, release } = await startHeldHost(root);
  const { client, drop, exit } = await attachPrivateClient(host);
  try {
    const admitted = client.catalog.workspaceRoots({ operation: 'list' });
    await entered.promise;
    drop();
    const unread = client.request('thread/list', {}).catch((cause: unknown) => cause);
    const closing = host.close();
    release.resolve();
    await expect(admitted).resolves.toBeDefined();
    await closing;
    exit();
    const refusal = await unread;
    expect(refusal).toMatchObject({ code: 'host.closing', failure: { kind: 'refusal' } });
    // A later command is refused without being written into the closed transport.
    await expect(client.request('thread/list', {})).rejects.toBe(refusal);
  } finally {
    release.resolve();
    exit();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('a host that ends the transport before it drained leaves what it may have read lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-interrupted-retirement-'));
  const { entered, host, release } = await startHeldHost(root);
  const { announced, client, cut, drop, exit } = await attachPrivateClient(host);
  try {
    const admitted = client.catalog
      .workspaceRoots({ operation: 'list' })
      .catch((cause: unknown) => cause);
    await entered.promise;
    drop();
    const unread = client.request('thread/list', {}).catch((cause: unknown) => cause);
    const closing = host.close();
    await announced;
    // As a host crash mid-retirement: the admitted request may have been served.
    cut();
    for (const failure of [await admitted, await unread]) {
      expect(isConnectionLoss(failure)).toBe(true);
    }
    await expect(client.request('thread/list', {})).rejects.toMatchObject({
      code: 'host.closing',
    });
    release.resolve();
    await closing;
  } finally {
    release.resolve();
    exit();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('a host that exits without announcing its retirement leaves its unanswered request lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-unannounced-exit-'));
  const { host, release } = await startHeldHost(root);
  const { client, drop, exit } = await attachPrivateClient(host);
  try {
    drop();
    const unread = client.request('thread/list', {}).catch((cause: unknown) => cause);
    exit();
    const failure = await unread;
    expect(isConnectionLoss(failure)).toBe(true);
    expect(failure).toMatchObject({ failure: { code: 'host.connection-lost' } });
  } finally {
    release.resolve();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});
