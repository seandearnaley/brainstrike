import { mkdtemp, rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { attachAgentHost } from '../src/client.js';
import { startAgentHost } from '../src/runtime.js';

const platform = () => ({
  close: async () => undefined,
  readPermissionPolicy: () => ({
    policies: { ...DEFAULT_PERMISSION_POLICIES, INTERNAL_FAULT },
    yolo: false,
  }),
  tools: {},
});
const models = [{ enabled: true, modelId: 'gpt-5.4', providerId: 'openai' }];
test('authenticated CLI-first catalog writes use the existing writer and survive reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-catalog-'));
  let host = await startAgentHost({ lifetime: 'persistent', root }, platform());
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.connect(host.record.endpoint);
  });
  const connection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket)
  );
  connection.listen();
  try {
    await expect(
      connection.sendRequest('host/model-choices', { operation: 'snapshot' })
    ).rejects.toMatchObject({ code: -32_601 });
    await expect(
      connection.sendRequest('initialize', {
        hostVersion: host.record.hostVersion,
        protocolVersion: host.record.protocolVersion,
        token: '0'.repeat(64),
      })
    ).rejects.toMatchObject({ data: { code: 'host.authentication-failed' } });
    await expect(
      connection.sendRequest('host/model-choices', { operation: 'snapshot' })
    ).rejects.toMatchObject({ code: -32_601 });
    await connection.sendRequest('initialize', {
      hostVersion: host.record.hostVersion,
      protocolVersion: host.record.protocolVersion,
      token: host.record.token,
    });
    await expect(
      connection.sendRequest('host/model-choices', {
        injectedSecret: 'must-never-cross',
        models,
        operation: 'models',
      })
    ).rejects.toMatchObject({ data: { ...INTERNAL_FAULT, correlationId: expect.any(String) } });
    expect(
      await connection.sendRequest('host/model-choices', { models, operation: 'models' })
    ).toEqual({ models, previous: { models: [], providers: [] }, providers: [] });
    connection.dispose();
    socket.destroy();
    await host.close();
    host = await startAgentHost({ lifetime: 'persistent', root }, platform());
    const client = await attachAgentHost(host.record);
    try {
      expect(await client.catalog.modelChoices({ operation: 'snapshot' })).toEqual({
        models,
        providers: [],
      });
      expect(
        await client.catalog.threadGroups({ operation: 'list', resourceId: 'default' })
      ).toEqual({ groups: [], placements: [] });
    } finally {
      await client.close();
    }
  } finally {
    connection.dispose();
    socket.destroy();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('host retirement drains an authenticated admitted catalog write before retiring its writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-catalog-drain-'));
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let writer: StateStore | undefined;
  const host = await startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
    writer = startup.store;
    return platform();
  });
  if (!writer) {
    throw new Error('Host did not acquire its writer');
  }
  const original = writer.modelChoices.bind(writer);
  vi.spyOn(writer, 'modelChoices').mockImplementation(async (request) => {
    entered.resolve();
    await released.promise;
    return await original(request);
  });
  const client = await attachAgentHost(host.record);
  const request = client.catalog.modelChoices({ models, operation: 'models' });
  request.catch(() => undefined);
  await entered.promise;
  let closed = false;
  const closing = host.close().then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    released.resolve();
    expect(await request).toEqual({
      models,
      previous: { models: [], providers: [] },
      providers: [],
    });
    await closing;
    expect(closed).toBe(true);
  } finally {
    released.resolve();
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});
