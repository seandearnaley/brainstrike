import { mkdtemp, rm } from 'node:fs/promises';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import { StreamMessageWriter } from 'vscode-jsonrpc/node';
import { attachAgentHost } from '../src/client.js';
import { startAgentHost } from '../src/runtime.js';

test('a host closing refusal retires client admission while its earlier write still joins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-refused-client-'));
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
  const client = await attachAgentHost(host.record);
  try {
    const admitted = client.catalog.workspaceRoots({ operation: 'list' });
    await entered.promise;
    const closing = host.close();
    const refusal: unknown = await client.catalog
      .workspaceRoots({ operation: 'list' })
      .catch((cause: unknown) => cause);
    expect(refusal).toMatchObject({ code: 'host.closing', failure: { kind: 'refusal' } });
    release.resolve();
    await admitted;
    await closing;
    // The restore's next catalog command is not allowed to write into the
    // transport whose owner already refused this client as terminally closing.
    await expect(client.catalog.workspaceRoots({ operation: 'list' })).rejects.toBe(refusal);
    await expect(client.request('thread/list', {})).rejects.toBe(refusal);
  } finally {
    release.resolve();
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('retirement joins a closing refusal received after the admitted-request join began', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-closing-refusal-'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refusing = Promise.withResolvers<void>();
  const writeRefusal = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
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
  const client = await attachAgentHost(host.record);
  const closeServer = Server.prototype.close;
  const server = vi.spyOn(Server.prototype, 'close').mockImplementation(function (
    this: Server,
    callback
  ) {
    stopping.resolve();
    return closeServer.call(this, callback);
  });
  const write = StreamMessageWriter.prototype.write;
  const writer = vi
    .spyOn(StreamMessageWriter.prototype, 'write')
    .mockImplementation(async function (this: StreamMessageWriter, message) {
      if ('error' in message) {
        refusing.resolve();
        await writeRefusal.promise;
      }
      return write.call(this, message);
    });
  try {
    const admitted = client.catalog.workspaceRoots({ operation: 'list' });
    await entered.promise;
    const closing = host.close();
    await stopping.promise;
    // Core's catalog endpoint is joining the held read. A new request is
    // refused by the live connection; hold that response's actual writer.
    const refused = client.catalog
      .workspaceRoots({ operation: 'list' })
      .catch((cause: unknown) => cause);
    await refusing.promise;
    release.resolve();
    await admitted;
    writeRefusal.resolve();
    expect(await refused).toMatchObject({ code: 'host.closing', failure: { kind: 'refusal' } });
    await closing;
  } finally {
    release.resolve();
    writeRefusal.resolve();
    writer.mockRestore();
    server.mockRestore();
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});
