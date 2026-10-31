// @vitest-environment jsdom
import { PassThrough } from 'node:stream';
import { authenticateHostClient } from '@brainstrike/agent-host/client';
import { AGENT_HOST_PROTOCOL_VERSION, parseHostParams } from '@brainstrike/agent-host/protocol';
import { registerDurableFlush } from '@brainstrike/app-state/renderer-close';
import {
  EMPTY_WORKSPACE_SNAPSHOT,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import type { HostRecord } from '@brainstrike/host-lease';
import { expect, test, vi } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';
import { installDesktopRendererClose } from '../../renderer/desktop-renderer-close';
import { hostThreadWorkspaceRepository } from '../../renderer/host-thread-workspace';

vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

test('joins an admitted workspace save ACK before closing the frame host connection', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const closed = Promise.withResolvers<void>();
  const record: HostRecord = {
    endpoint: '/tmp/disposable-workspace-close-ack',
    hostVersion: '0.1.0',
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'disposable workspace ACK fixture',
    token: 'a'.repeat(64),
  };
  const server = createMessageConnection(
    new StreamMessageReader(input),
    new StreamMessageWriter(output)
  );
  server.onRequest('initialize', () => ({
    hostVersion: record.hostVersion,
    pid: record.pid,
    protocolVersion: record.protocolVersion,
    start: record.start,
  }));
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  server.onRequest('thread/workspace/set', async (input: unknown) => {
    parseHostParams('thread/workspace/set', input);
    admitted.resolve();
    await release.promise;
    return { accepted: true };
  });
  server.listen();
  const connection = createDesktopHostConnection(() =>
    authenticateHostClient(
      createMessageConnection(new StreamMessageReader(output), new StreamMessageWriter(input)),
      record,
      async () => {
        server.dispose();
        input.destroy();
        output.destroy();
        closed.resolve();
      },
      closed.promise
    )
  );
  const repository = hostThreadWorkspaceRepository(() => connection.current());
  const events: string[] = [];
  const save = repository.setThreadWorkspace(
    'thread-a',
    WORKSPACE_MEMORY_RESOURCE_ID,
    EMPTY_WORKSPACE_SNAPSHOT
  );
  const saved = save.then(
    () => events.push('save-ack'),
    () => events.push('save-rejected')
  );
  const unregister = registerDurableFlush(async () => await save);
  let prepare: (() => Promise<void>) | undefined;
  Object.assign(window, {
    agentHost: {
      connect: vi.fn(),
      onPrepareClose: (callback: () => Promise<void>) => {
        prepare = callback;
        return () => undefined;
      },
    },
  });
  installDesktopRendererClose(connection);
  try {
    await admitted.promise;
    if (!prepare) {
      throw new Error('The frame did not install its app-owned close preparation');
    }
    const closing = prepare().then(() => events.push('closed'));
    // App-owned preparation must keep the real JSON-RPC transport alive for its ACK.
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
    expect(events).toEqual([]);
    expect(connection.getSnapshot().kind).toBe('connected');
    release.resolve();
    await Promise.all([saved, closing]);
    expect(events).toEqual(['save-ack', 'closed']);
    expect(connection.getSnapshot().kind).toBe('closed');
  } finally {
    unregister();
    release.resolve();
    await saved;
    await connection.close();
    server.dispose();
    input.destroy();
    output.destroy();
  }
});
