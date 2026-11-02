/**
 * A window reaches its folders while Core folds its log: workspace methods answer at once, and
 * thread reads answer once the fold settles.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { HOST_VERSION } from '@brainstrike/host-lease';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { authenticateHostClient } from '../src/client-connection.js';
import { bindHostConnection } from '../src/connection.js';
import type { HostCore } from '../src/core.js';
import type { HostPlatform, HostRootRegistry } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol-version.js';
import { startAgentHost } from '../src/runtime.js';
import { nodePortConnection } from '../src/transports.js';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
});

/** A connection to a fake Core whose fold settles when the test says so. */
async function connectDuringFold() {
  const hydrated = Promise.withResolvers<void>();
  const folds = { done: false };
  let committed: ((row: HostLogRow) => void) | undefined;
  const core = {
    hydrated: hydrated.promise,
    listThreads: () => {
      if (!folds.done) {
        throw new Error('Core read its threads before the fold');
      }
      return [];
    },
    liveTelemetry: { replay: () => [] },
    onCommitted: (listener: (row: HostLogRow) => void) => {
      committed = listener;
      return () => undefined;
    },
    onTelemetry: () => () => undefined,
    published: { read: async () => [] },
    releaseMcpInputClient: () => undefined,
    store: {},
    trees: { changedBy: () => undefined },
  } as unknown as HostCore;
  const rootRegistry = {
    'workspace/roots/recent': async () => ({ roots: [] }),
  } as unknown as HostRootRegistry;
  const record = {
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'start',
  };
  const channel = new MessageChannel();
  const server = nodePortConnection(channel.port1);
  bindHostConnection(server, core, record, () => undefined, {
    origin: 'desktop-ui',
    rootRegistry,
  });
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
  closers.push(() => void client.close());
  const fold = (): void => {
    folds.done = true;
    hydrated.resolve();
  };
  return { client, commit: (row: HostLogRow) => committed?.(row), fold, server };
}

test('folders answer while Core folds its log, and thread reads wait for the fold', async () => {
  const { client, fold } = await connectDuringFold();
  let answered = false;
  const threads = client.request('thread/list', {}).then((result) => {
    answered = true;
    return result;
  });
  // Sent after the thread list, the folders answer first: the list waits for the fold.
  await expect(client.request('workspace/roots/recent', {})).resolves.toEqual({ roots: [] });
  expect(answered).toBe(false);
  fold();
  await expect(threads).resolves.toEqual({ threads: [] });
});

test('a view that subscribes and unsubscribes during the fold is not sent its rows', async () => {
  const { client, commit, fold, server } = await connectDuringFold();
  const sent = vi.spyOn(server, 'sendNotification');
  const subscribed = client.request('log/subscribe', { fromSeq: 0, threadId: 'thread-a' });
  const unsubscribed = client.request('log/unsubscribe', { threadId: 'thread-a' });
  await client.request('workspace/roots/recent', {});
  fold();
  await subscribed;
  await unsubscribed;
  commit({ seq: 1, threadId: 'thread-a' } as unknown as HostLogRow);
  expect(sent.mock.calls.map(([method]) => method)).not.toContain('log/event');
});

test('a fold that fails after the host is ready closes the host and is its failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-host-fold-'));
  try {
    const platform: HostPlatform = {
      attachMcpTaskOwner: () => {
        throw new Error('fold failed');
      },
      close: async () => undefined,
      maxSteps: 1,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => {
        throw new Error('No model');
      },
      tools: {},
    };
    const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    await expect(host.closed).rejects.toThrow('fold failed');
    await host.close();
    expect(RootLock.inspect(root)?.owner.released ?? true).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
