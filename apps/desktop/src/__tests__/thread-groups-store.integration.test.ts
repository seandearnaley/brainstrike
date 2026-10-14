// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { StateStore } from '@brainstrike/state-store';
import { AGENT_SEMANTIC_COLOR_IDS, ASSISTANT_THREAD_ICON_IDS } from '@brainstrike/types';
import { expect, test } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  createThreadGroupsClient,
  serveThreadGroups,
} from '../agent-host-platform/thread-groups-store';

test('private thread group commands preserve committed IDs and reject malformed mutations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-thread-groups-'));
  const store = await StateStore.open(directory);
  const input = new PassThrough();
  const output = new PassThrough();
  const client = createMessageConnection(
    new StreamMessageReader(output),
    new StreamMessageWriter(input)
  );
  const server = createMessageConnection(
    new StreamMessageReader(input),
    new StreamMessageWriter(output)
  );
  const endpoint = serveThreadGroups(server, store);
  client.listen();
  server.listen();
  try {
    const port = createThreadGroupsClient(client);
    const group = {
      color: 'blue' as const,
      icon: 'code' as const,
      id: 'thread-group-current',
      name: 'Review',
      rank: 'a0',
      resourceId: 'brainstrike:workspace',
    };
    expect(await port.threadGroups({ group, operation: 'create' })).toEqual({
      groups: [group],
      placements: [],
    });
    for (const color of [...AGENT_SEMANTIC_COLOR_IDS, null]) {
      await port.threadGroups({ color, groupId: group.id, operation: 'color' });
      const reply = await port.threadGroups({ operation: 'list', resourceId: group.resourceId });
      expect(reply.groups.find((entry) => entry.id === group.id)?.color).toBe(color);
    }
    for (const icon of [...ASSISTANT_THREAD_ICON_IDS, null]) {
      await port.threadGroups({ groupId: group.id, icon, operation: 'icon' });
      const reply = await port.threadGroups({ operation: 'list', resourceId: group.resourceId });
      expect(reply.groups.find((entry) => entry.id === group.id)?.icon).toBe(icon);
    }
    await port.threadGroups({ color: group.color, groupId: group.id, operation: 'color' });
    await port.threadGroups({ groupId: group.id, icon: group.icon, operation: 'icon' });
    await expect(
      client.sendRequest('host/thread-groups', {
        color: 'secret-new-color',
        groupId: group.id,
        operation: 'color',
      })
    ).rejects.toThrow();
    await expect(
      client.sendRequest('host/thread-groups', {
        groupId: group.id,
        operation: 'delete',
        resourceId: 'unexpected',
      })
    ).rejects.toThrow();
    expect(await port.threadGroups({ operation: 'list', resourceId: group.resourceId })).toEqual({
      groups: [group],
      placements: [],
    });
  } finally {
    await endpoint.close();
    client.dispose();
    server.dispose();
    input.destroy();
    output.destroy();
    await store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
