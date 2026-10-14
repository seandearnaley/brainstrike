import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { expect, test } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const axis = (n: number) => Array.from({ length: 384 }, (_, index) => (index === n ? 1 : 0));
test('prompt vectors preserve own IDs and revision fences across reopen without creating thread rows', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'prompt-native-')));
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: [],
    stateProjection: {
      mode: 'dev',
      module: new URL('./fixtures/state-search-schema.mjs', import.meta.url).href,
    },
    stateRoot: root,
  };
  let port = await openIndexer(options, deadlines);
  try {
    await port.promptVectors({
      id: 'prompt-item-original',
      operation: 'put',
      revision: 1,
      vector: axis(0),
    });
    expect(
      (
        await port.promptVectors({
          items: [{ id: 'prompt-item-original', revision: 1 }],
          operation: 'status',
        })
      ).rows
    ).toMatchObject([{ error: null, id: 'prompt-item-original', revision: 1 }]);
    expect(
      (
        await port.promptVectors({
          items: [{ id: 'prompt-item-original', revision: 1 }],
          limit: 6,
          operation: 'similar',
          threshold: 0.35,
          vector: axis(0),
        })
      ).hits
    ).toEqual([{ id: 'prompt-item-original', revision: 1, similarity: 1 }]);
    expect(
      (
        await port.promptVectors({
          items: [{ id: 'prompt-item-original', revision: 2 }],
          limit: 6,
          operation: 'similar',
          threshold: 0.35,
          vector: axis(0),
        })
      ).hits
    ).toEqual([]);
    await port.close();
    port = await openIndexer(options, deadlines);
    expect(
      (
        await port.promptVectors({
          items: [{ id: 'prompt-item-original', revision: 1 }],
          operation: 'status',
        })
      ).rows
    ).toHaveLength(1);
    await port.promptVectors({
      error: 'Recorded renderer failure',
      id: 'prompt-item-original',
      operation: 'error',
      revision: 1,
    });
    expect(
      (
        await port.promptVectors({
          items: [{ id: 'prompt-item-original', revision: 1 }],
          operation: 'status',
        })
      ).rows[0]
    ).toMatchObject({ error: 'Recorded renderer failure' });
    expect(
      (
        await port.promptVectors({
          items: [{ id: 'prompt-item-original', revision: 1 }],
          limit: 6,
          operation: 'similar',
          threshold: 0.35,
          vector: axis(0),
        })
      ).hits
    ).toEqual([]);
    await expect(
      port.promptVectors({ id: 'prompt-item-original', operation: 'put', revision: 1, vector: [1] })
    ).rejects.toThrow();
    await port.promptVectors({ ids: ['prompt-item-original'], operation: 'delete' });
    expect(
      (
        await port.promptVectors({
          items: [{ id: 'prompt-item-original', revision: 1 }],
          operation: 'status',
        })
      ).rows
    ).toEqual([]);
  } finally {
    await port.close();
    await rm(root, { force: true, recursive: true });
  }
});
