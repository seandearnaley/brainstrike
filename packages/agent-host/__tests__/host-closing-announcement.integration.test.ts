import { randomUUID } from 'node:crypto';
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
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { stdioConnection } from '../src/transports.js';

/** A host whose workspace-root registration waits for `release`, as a slow admitted write. */
async function startHeldHost(root: string) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host = await startAgentHost({ lifetime: 'persistent', root }, ({ store }) => {
    const register = store.workspaceRoots.bind(store);
    vi.spyOn(store, 'workspaceRoots').mockImplementation(async (request) => {
      const reply = await register(request);
      if (request.operation === 'register') {
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
 * exits; `exit` ends the transport as the host process's exit does.
 */
async function attachPrivateClient(host: AgentHost) {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  host.bindClientConnection(stdioConnection(toHost, toClient), 'desktop-ui');
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
  const connection = createMessageConnection(
    new StreamMessageReader(toClient),
    new StreamMessageWriter(writes)
  );
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
    client,
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
    const registering = client.catalog.workspaceRoots({
      operation: 'register',
      root: { displayName: 'workspace', path: root, preferredId: randomUUID() },
    });
    await entered.promise;
    drop();
    const unread = client.request('thread/list', {}).catch((cause: unknown) => cause);
    const closing = host.close();
    release.resolve();
    await expect(registering).resolves.toBeDefined();
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
