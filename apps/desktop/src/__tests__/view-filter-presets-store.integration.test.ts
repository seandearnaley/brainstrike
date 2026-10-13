// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  createViewFilterPresetClient,
  serveViewFilterPresets,
} from '../agent-host-platform/view-filter-preset-store';

test('the private host connection returns committed preset identities and drains before closing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-preset-wire-'));
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
  const owner = serveViewFilterPresets(server, store);
  client.listen();
  server.listen();
  try {
    const port = createViewFilterPresetClient(client);
    const created = await port.viewFilterPresets({
      input: { excludes: [], includes: ['*.ts'], name: 'Wire source' },
      operation: 'create',
    });
    const record = created.presets[0];
    if (!record) {
      throw new Error('Committed preset missing');
    }
    expect((await store.viewFilterPresets({ operation: 'list' })).presets).toContainEqual(record);
    const updated = await port.viewFilterPresets({
      id: record.id,
      input: { useRegex: true },
      operation: 'update',
    });
    expect(updated.presets[0]).toMatchObject({ id: record.id, useRegex: true });
    const before = await store.viewFilterPresets({ operation: 'list' });
    await expect(
      client.sendRequest('host/view-filter-presets', {
        id: record.id,
        input: { isDefault: true },
        operation: 'update',
      })
    ).rejects.toThrow();
    expect(await store.viewFilterPresets({ operation: 'list' })).toEqual(before);
  } finally {
    await owner.close();
    client.dispose();
    server.dispose();
    input.destroy();
    output.destroy();
    await store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
